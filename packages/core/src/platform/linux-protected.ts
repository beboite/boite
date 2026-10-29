import {existsSync, lstatSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';
import {inside} from '../contacts/file-policy.ts';
import {assertExecutionPolicy, executionFileIdentity, type ExecutionPolicy} from '../execution-policy.ts';
import type {NativeExecutionBoundary, NativeExecutionSession, ProtectedLaunch, ProtectionRunner} from './protected.ts';
import {ProtectedCheckout} from './protected-checkout.ts';
import {linuxToolSeccomp} from './linux-tool-seccomp.ts';

const MINIMUM_BWRAP = [0, 13, 1];
const RUNTIME = ['/usr/bin', '/usr/lib', '/usr/lib64', '/usr/include', '/usr/share', '/lib', '/lib64', '/bin'];
const environment = (): Record<string, string> => ({PATH: '/usr/bin:/bin', HOME: '/home/tool', TMPDIR: '/tmp',
  XDG_CONFIG_HOME: '/home/tool/.config', XDG_CACHE_HOME: '/home/tool/.cache', XDG_DATA_HOME: '/home/tool/.local/share',
  LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'});

/** Uses the maintained, unprivileged bubblewrap launcher. Never tries sudo, setuid or a weaker fallback. */
export class LinuxExecutionBoundary implements NativeExecutionBoundary {
  constructor(private readonly executable: () => string | null = () => process.env.BOITE_BWRAP_PATH || Bun.which('bwrap')) {}
  available(): boolean { const path = this.executable(); return !!path && existsSync(path); }

  async open(policy: ExecutionPolicy, run: ProtectionRunner): Promise<NativeExecutionSession> {
    if (policy.credentialPaths.some(c => RUNTIME.some(path => inside(path, c) || inside(c, path)))) {
      throw new Error('execution.credentialPaths: credential files cannot overlap the public system toolchain; use an isolated toolchain');
    }
    const candidate = this.executable();
    if (!candidate) throw new Error('execution.linux.bwrap: bubblewrap >= 0.13.1 is required; install the userspace helper described in docs/contacts.md');
    const bwrap = realpathSync(candidate), binary = lstatSync(bwrap);
    if (!isAbsolute(bwrap) || !binary.isFile() || !(binary.mode & 0o111) || binary.mode & 0o6000) throw new Error('execution.linux.bwrap: expected an executable without setuid/setgid permissions');
    const identity = executionFileIdentity(bwrap);
    const version = await run(bwrap, ['--version'], policy.checkout);
    const parsed = /^bubblewrap (\d+)\.(\d+)\.(\d+)\s*$/.exec(version.stdout);
    const parts = parsed?.slice(1).map(Number);
    if (version.code !== 0 || !parts || parts[0]! < MINIMUM_BWRAP[0]!
      || parts[0] === 0 && (parts[1]! < MINIMUM_BWRAP[1]! || parts[1] === MINIMUM_BWRAP[1] && parts[2]! < MINIMUM_BWRAP[2]!)) {
      throw new Error('execution.linux.bwrap: expected maintained bubblewrap >= 0.13.1');
    }
    const filterBytes = linuxToolSeccomp();
    const checkout = new ProtectedCheckout(policy);
    const filter = resolve(checkout.scratch, 'tool-seccomp.bpf');
    const launch = (command: string, args: string[], cwd: string): ProtectedLaunch => {
      assertExecutionPolicy(policy);
      checkout.checkOverrides();
      if (executionFileIdentity(bwrap) !== identity) throw new Error('execution.linux.bwrap: captured launcher changed');
      if (!isAbsolute(cwd) || !inside(policy.checkout, resolve(cwd))) throw new Error('execution.cwd: expected a directory in the captured checkout');
      const local = resolve(checkout.root, relative(policy.checkout, cwd));
      if (realpathSync(local) !== local || !lstatSync(local).isDirectory()) throw new Error('execution.cwd: expected a real directory in the private checkout');
      const sandbox = ['--unshare-all', '--unshare-user', '--unshare-pid', '--unshare-net', '--seccomp', '3',
        '--new-session', '--die-with-parent', '--cap-drop', 'ALL', '--hostname', 'boite-tool', '--clearenv'];
      for (const path of RUNTIME) {
        if (!existsSync(path)) continue;
        if (inside(path, policy.checkout) || inside(policy.checkout, path)) throw new Error('execution.checkout: project must be outside the public system toolchain');
        // Keep merged-/usr symlinks rather than mounting the same tree twice.
        const real = realpathSync(path);
        sandbox.push(...(real !== path ? ['--symlink', real, path] : ['--ro-bind', path, path]));
      }
      sandbox.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home/tool',
        '--bind', checkout.root, policy.checkout);
      for (const executable of policy.executables) {
        if (!RUNTIME.some(path => inside(path, executable.path))) sandbox.push('--ro-bind', executable.path, executable.path);
      }
      // Account/credential roots are absent, including aliases; toolchain overlaps are refused above.
      for (const override of policy.readOverrides) sandbox.push('--ro-bind', resolve(checkout.root, override.path), resolve(policy.checkout, override.path));
      const env = environment();
      for (const [key, value] of Object.entries(env)) sandbox.push('--setenv', key, value);
      sandbox.push('--chdir', resolve(cwd), '--', command, ...args);
      // Fixed bootstrap only opens the core-generated BPF descriptor. Untrusted argv is
      // quoted data, and reaches exec only after bubblewrap installed the OS boundary.
      return {command: '/bin/sh', args: ['-c', 'exec 3<"$1"; shift; exec "$@"', 'boite-tool-bootstrap', filter, bwrap, ...sandbox], cwd: checkout.scratch, env};
    };
    try {
      writeFileSync(filter, filterBytes, {mode: 0o400});
      // Exercise the exact namespace, mounts, environment and nested-userns refusal used by tools.
      const probe = launch('/bin/sh', ['-c', 'test -r /proc/self/status && test -d "$HOME" && test -w . && command -v unshare >/dev/null && ! unshare -Ur true 2>/dev/null && printf protected-native-ready'], policy.checkout);
      const result = await run(probe.command, probe.args, probe.cwd);
      if (result.code !== 0 || result.stdout !== 'protected-native-ready') throw new Error(`execution.linux.namespaces: native protected launch failed (exit ${result.code}): ${result.stderr.trim()}; no unprotected fallback`);
      assertExecutionPolicy(policy);
      return {launch, flush: () => checkout.flush(), close: () => checkout.close()};
    } catch (error) { checkout.close(); throw error; }
  }
}
