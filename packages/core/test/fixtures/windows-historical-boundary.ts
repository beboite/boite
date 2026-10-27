// Frozen v1 diagnostic orchestration; never imported by production.
// Source SHA256 before import/class renaming: 1aabfeefb51eeb5fcb505e97582265123860d02eb62e166e9f925a6523718277
import {dlopen, FFIType, ptr} from 'bun:ffi';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {basename, dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {inside} from '../../src/contacts/file-policy.ts';
import {assertExecutionPolicy, executionIdentity, type ExecutionPolicy} from '../../src/execution-policy.ts';
import type {NativeExecutionBoundary, NativeExecutionSession, ProtectedLaunch, ProtectionRunner} from '../../src/platform/protected.ts';
import {ProtectedCheckout} from '../../src/platform/protected-checkout.ts';

const version = 'boite-windows-protected 1';
const wide = (value: string) => Buffer.from(`${value}\0`, 'utf16le');
// Windows may update only ChangeTime on first execution (for example an image
// trust cache). Pin both the file object and actual bytes instead of that timestamp.
const helperIdentity = (path: string) => `${executionIdentity(path)}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;

/** A private LPAC identity plus a non-breakaway kernel job; never changes a host ACL. */
export class HistoricalWindowsExecutionBoundary implements NativeExecutionBoundary {
  constructor(private readonly executable: () => string | null = () => process.env.BOITE_WINDOWS_SANDBOX_PATH
    || (existsSync(join(dirname(process.execPath), 'protected-tool.exe')) ? join(dirname(process.execPath), 'protected-tool.exe') : null)) {}
  available(): boolean {const path = this.executable(); return !!path && existsSync(path);}

  async open(policy: ExecutionPolicy, run: ProtectionRunner): Promise<NativeExecutionSession> {
    const candidate = this.executable();
    if (!candidate) throw new Error('execution.windows.helper: protected-tool.exe is required; build the userspace helper described in docs/contacts.md');
    const helper = realpathSync(candidate);
    if (!isAbsolute(helper) || !lstatSync(helper).isFile()) throw new Error('execution.windows.helper: expected a canonical native helper executable');
    const identity = helperIdentity(helper);
    const windows = realpathSync(process.env['SystemRoot'] || 'C:\\Windows');
    if (policy.credentialPaths.some(path => inside(windows, path) || inside(path, windows))
      || inside(windows, policy.checkout)) throw new Error('execution.windows.runtime: credentials and checkout must be outside the public Windows runtime');
    const checked = await run(helper, ['--version'], policy.checkout);
    if (checked.code || checked.stdout !== version) throw new Error('execution.windows.helper: expected boite-windows-protected 1');
    const checkout = new ProtectedCheckout(policy), profile = `boite.tool.${policy.capabilityId}`;
    const runtime = join(checkout.scratch, 'runtime'), home = join(checkout.scratch, 'home');
    const binaries = new Map<string, string>(), aliases = new Map<string, string>();
    let prepared = false, closed = false;
    const close = () => {
      if (closed) return;
      // Core-owned FFI cleanup still runs after the captured runner has been revoked.
      // DeleteAppContainerProfile touches only this unpredictable task-created profile.
      if (prepared) {
        const library = dlopen('userenv.dll', {DeleteAppContainerProfile: {args: [FFIType.ptr], returns: FFIType.i32}});
        try {
          const name = wide(profile), hr = library.symbols.DeleteAppContainerProfile(ptr(name));
          if (hr !== 0 && (hr >>> 0) !== 0x80070002) throw new Error(`execution.windows.profile.cleanup: DeleteAppContainerProfile failed (${hr >>> 0})`);
        } finally {library.close();}
      }
      checkout.close(); closed = true;
    };
    try {
      mkdirSync(runtime); mkdirSync(home); mkdirSync(join(home, 'temp'));
      for (const executable of policy.executables) {
        const name = basename(executable.path).toLowerCase();
        if (aliases.has(name)) throw new Error('execution.executables: Windows toolchain basenames must be unique');
        const dest = join(runtime, basename(executable.path));
        copyFileSync(executable.path, dest);
        binaries.set(executable.path.toLowerCase(), dest); aliases.set(name, dest);
      }
      const probeExecutable = join(runtime, 'boite-native-probe.exe');
      if (existsSync(probeExecutable)) throw new Error('execution.executables: boite-native-probe.exe is reserved for native admission');
      copyFileSync(helper, probeExecutable);
      const env: Record<string, string> = {SystemRoot: windows, WINDIR: windows,
        PATH: `${runtime};${join(windows, 'System32')}`, COMSPEC: join(windows, 'System32', 'cmd.exe'),
        HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, TEMP: join(home, 'temp'), TMP: join(home, 'temp'),
        CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL'};
      const launch = (command: string, args: string[], cwd: string): ProtectedLaunch => {
        if (closed) throw new Error('execution.windows: private view is closed');
        assertExecutionPolicy(policy); checkout.checkOverrides();
        if (helperIdentity(helper) !== identity) throw new Error('execution.windows.helper: captured launcher bytes or file identity changed');
        if (!isAbsolute(cwd) || !inside(policy.checkout, resolve(cwd))) throw new Error('execution.cwd: expected a directory in the captured checkout');
        const local = resolve(checkout.root, relative(policy.checkout, cwd));
        if (realpathSync(local) !== local || !lstatSync(local).isDirectory()) throw new Error('execution.cwd: expected a real private checkout directory');
        let executable = binaries.get(command.toLowerCase()) || aliases.get(command.toLowerCase());
        if (!executable) {
          const path = isAbsolute(command) ? resolve(command) : command.includes('\\') || command.includes('/')
            ? resolve(local, command) : join(windows, 'System32', /\.exe$/i.test(command) ? command : `${command}.exe`);
          const mapped = inside(policy.checkout, path) ? resolve(checkout.root, relative(policy.checkout, path)) : path;
          if (!inside(checkout.root, mapped) && !inside(join(windows, 'System32'), mapped)
            || !/\.exe$/i.test(mapped) || realpathSync(mapped) !== mapped || !lstatSync(mapped).isFile()) {
            throw new Error('execution.command: expected a captured toolchain, public System32 executable or private project executable');
          }
          executable = mapped;
        }
        return {command: helper, args: ['run', profile, local, executable, ...args], cwd: checkout.scratch, env};
      };
      // No untrusted process is launched until its private ACLs and unique profile exist.
      prepared = true; // Also clean a profile if cancellation interrupts native setup after creation.
      const setup = await run(helper, ['setup', profile, checkout.scratch, checkout.root, runtime, home,
        ...policy.readOverrides.map(override => resolve(checkout.root, override.path))], checkout.scratch);
      if (setup.code || setup.stdout !== 'protected-native-prepared') throw new Error(`execution.windows.setup: native preparation failed (${setup.code}): ${setup.stderr.trim()}`);
      const result = await run(helper, ['run', profile, checkout.root, probeExecutable, '--probe', join(checkout.scratch, 'ambient-probe')], checkout.scratch, env);
      if (result.code || result.stdout !== version) throw new Error(`execution.windows.lpac: native protected launch failed (${result.code}): ${result.stderr.trim()}; no unprotected fallback`);
      assertExecutionPolicy(policy);
      return {launch, flush: () => checkout.flush(), close};
    } catch (error) {close(); throw error;}
  }
}
