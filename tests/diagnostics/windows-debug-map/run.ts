import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, release} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {capture, type Captured} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {sha256, sourceHash, sourcePath, writeSource} from './generate.ts';
import {installOwnership, prepareOwnership, ownershipTestArgs, verifyOwnershipPlatform, ownedFaultRootReference} from './ownership-generate.ts';
import {summarizeOwnership} from './ownership-summary.ts';
import {startFaultRootService} from './fault-root-reference.ts';
import {acceptsNullMessageProbe} from './null-message.ts';

const [output, mode] = process.argv.slice(2);
if (!output || !isAbsolute(output) || (mode && mode !== '--compile-only')) {
  throw new Error('usage: bun tests/diagnostics/windows-debug-map/run.ts <absolute artifact directory> [--compile-only]');
}
mkdirSync(output, {recursive: true});
const resultPath = join(output, 'diagnostic.json');
if (existsSync(resultPath)) throw new Error('diagnostic.json already exists: choose a fresh output directory to preserve evidence');
const compileOnly = mode === '--compile-only';
const enabled = process.platform === 'win32' && process.env.BOITE_TEST_DEBUG_MAP === '1';
const results: Record<string, unknown>[] = [];
const manifest: Record<string, unknown> = {
  kernel: release(), platform: process.platform, arch: process.arch, bun: Bun.version,
  sourceHash, sourceObservedSha256: sha256(readFileSync(sourcePath)),
  compileOnly, enabled, results, productionAccepted: false, exitCode: null,
};
const save = () => writeFileSync(resultPath, JSON.stringify(manifest, null, 2) + '\n');
save();
if (!compileOnly && !enabled) {
  manifest.skipped = 'requires Windows and explicit BOITE_TEST_DEBUG_MAP=1; no native fixture allocated';
  manifest.exitCode = 0; save(); console.log(manifest.skipped); process.exit(0);
}

// All compiler/test processes use the real process registry and ProcessPlatform.
// Redirect the canonical Windows module before either owner imports core code.
const ownership = enabled && !compileOnly ? prepareOwnership(join(output, 'ownership-source')) : undefined;
if (ownership) {
  process.env.BOITE_DEBUG_MAP_OWNERSHIP = '1'; process.env.BOITE_TEST_DEBUG_MAP = '1';
  process.env.BOITE_DEBUG_MAP_OWNER = 'launcher';
  if (!await installOwnership(ownership.jobs)) throw new Error('launcher ownership interception not installed');
  manifest.ownership = ownership;
}
const trace = ownership ? (await import('./ownership-trace.ts')).ownershipTrace : undefined;
const {Journal} = await import('../../../packages/core/src/journal.ts');
const {Bus} = await import('../../../packages/core/src/bus.ts');
const {ProcRegistry} = await import('../../../packages/core/src/procs.ts');
const scratch = mkdtempSync(join(tmpdir(), 'boite-debug-map-build-'));
let procs: InstanceType<typeof ProcRegistry> | undefined;
let exitCode = 0;
try {
  const hashes = writeSource(output); manifest.sourceHashes = hashes;
  const nullSource = readFileSync(join(import.meta.dir, 'null-message.c'));
  writeFileSync(join(output, 'null-message.c'), nullSource);
  hashes['null-message.c'] = sha256(nullSource);
  if (ownership) for (const file of ['jobs.ts', 'jobs-worker.ts', 'preload.ts', 'provenance.json'])
    hashes[`ownership-source/${file}`] = sha256(readFileSync(join(ownership.directory, file)));
  for (const file of ['generate.ts', 'run.ts', 'routing.test.ts', 'environment.ts', 'capture.ts', 'gates.md', 'target-topology.ts', 'target-topology.test.ts', 'target-topology-export.txt', 'helper-job.ts', 'helper-job.test.ts', 'helper-reference.ts', 'helper-reference.test.ts', 'helper-reference-export.txt', 'worker-lifetime.ts', 'worker-lifetime.test.ts', 'retirement-timing.ts', 'retirement-timing.test.ts', 'directory-twin.ts', 'directory-twin.test.ts', 'retirement-fixture.ts', 'anchor-overlap.ts', 'anchor-overlap.test.ts', 'target-acl.test.ts', 'target-acl-cases.c',
    'fault-root-reference.ts', 'fault-root-reference.test.ts', 'fault-root-reference-export.txt', 'matched-root-reference.ts', 'matched-root-reference.test.ts', 'live-root-fence.ts', 'live-root-reference.ts', 'live-root-reference.test.ts', 'live-root-harness.ts', 'live-root-drain.ts', 'live-root-drain.test.ts', 'live-root-drain-export.txt',
    'stdio-root-fence.ts', 'live-fence-dispatch.ts', 'stdio-root-reference.ts', 'stdio-root-reference.test.ts', 'stdio-stream-cases.c', 'stdio-stream-cases.test.ts',
    'stdout-write-fence.ts', 'stdout-write-reference.ts', 'stdout-write-reference.test.ts', 'stdio-reference-fixture.ts',
    'stdout-zero-fence.ts', 'stdout-zero-reference.ts', 'stdout-zero-reference.test.ts',
    'stdout-byte-fence.ts', 'stdout-byte-reference.ts', 'stdout-byte-reference.test.ts',
    'stdout-close-fence.ts', 'stdout-close-reference.ts', 'stdout-close-reference.test.ts',
    'debug-pipe.ts', 'debug-pipe.test.ts', 'debug-pipe-cases.c', 'debug-routing.ts',
    'control-schedule.ts', 'control-schedule.test.ts',
    'anchor-access-cases.c', 'ownership-generate.ts', 'ownership-ledger.ts', 'ownership-trace.ts', 'ownership-summary.ts', 'ownership.test.ts', 'null-message.ts', 'null-message.test.ts']) {
    hashes[file] = sha256(readFileSync(join(import.meta.dir, file)));
  }
  writeFileSync(join(output, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n'); save();
  const compilers = process.platform === 'win32'
    ? [{name: 'sdk', path: Bun.which('clang')}, {name: 'mingw', path: 'C:\\mingw64\\bin\\gcc.exe'}]
    : [{name: 'mingw-cross', path: Bun.which('x86_64-w64-mingw32-gcc')}];
  async function execute(id: string, executable: string, args: string[], env = selectedEnvironment()) {
    if (!procs) throw new Error('compiler registry not initialized');
    const child = procs.spawnPiped(id, executable, args, {cwd: output, env, agentRoot: false});
    const result = await capture(procs, id, child, id.startsWith('compile') ? 90000 : id.startsWith('null-message-') ? 20000 : 170000);
    writeFileSync(join(output!, `${id}.log`), `pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    console.log(`${id}: pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    return result;
  }
  for (const compiler of compilers) {
    const entry: Record<string, unknown> = {compiler: compiler.path, name: compiler.name}; results.push(entry);
    const directory = join(output, compiler.name); mkdirSync(directory);
    const traceDirectory = join(directory, 'ownership');
    if (trace) {
      process.env.BOITE_DEBUG_MAP_TRACE = traceDirectory;
      trace.start(traceDirectory);
      await verifyOwnershipPlatform();
    }
    let rootService: ReturnType<typeof startFaultRootService> | undefined;
    const journal = new Journal(join(scratch, `${compiler.name}.db`));
    procs = new ProcRegistry(journal, new Bus());
    try {
      if (!compiler.path || !existsSync(compiler.path)) throw new Error(`compiler unavailable: ${compiler.name}`);
      const helper = join(directory, 'debug-map.exe');
      const sdk = process.platform === 'win32' && /clang/i.test(compiler.path);
      const args = ['-O2', '-Wall', '-Wextra', '-Werror', join(output, 'debug-map.c'), '-o', helper,
        ...(sdk ? [] : ['-static']), '-luserenv', '-ladvapi32', '-lshell32', '-luser32'];
      entry.command = [compiler.path, ...args];
      const compiled = await execute(`compile-${compiler.name}`, compiler.path, args); entry.compile = compiled;
      if (compiled.code !== 0 || compiled.timedOut) throw new Error(`strict compile failed: ${compiler.name}`);
      hashes[`${compiler.name}/debug-map.exe`] = sha256(readFileSync(helper));
      if (!compileOnly) {
        const rootDirectory = join(directory, 'fault-root-control'), rootNonce = crypto.randomUUID().replaceAll('-', '');
        mkdirSync(rootDirectory, {mode: 0o700});
        rootService = startFaultRootService(rootDirectory, await ownedFaultRootReference(compiler.name, rootNonce, directory, traceDirectory, rootDirectory), action => trace!.preserve(action));
        let tested: Captured;
        try {tested = await execute(`native-${compiler.name}`, process.execPath,
          ownershipTestArgs(ownership!.preload, join(import.meta.dir, 'routing.test.ts')), selectedEnvironment({
            BOITE_ROOT_REFERENCE_DIRECTORY: rootDirectory, BOITE_ROOT_REFERENCE_NONCE: rootNonce, BOITE_ROOT_REFERENCE_COMPILER: compiler.name,
            BOITE_TEST_DEBUG_MAP: '1', BOITE_DEBUG_MAP_HELPER: helper, BOITE_DEBUG_MAP_OUTPUT: directory,
            BOITE_DEBUG_MAP_OWNERSHIP: '1', BOITE_DEBUG_MAP_OWNER: 'harness', BOITE_DEBUG_MAP_TRACE: traceDirectory,
            HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
          }));
        } finally {const service = rootService; rootService = undefined; await service?.stop();}
        entry.native = tested;
        if (tested.code !== 0 || tested.timedOut) exitCode = 1;
        if (!existsSync(join(directory, 'results.json'))) { entry.missingNativeResults = true; exitCode = 1; }
        else if (JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')).initialGatePassed !== true) exitCode = 1;
      }
      // Independent ordinary-process semantics. This neither replaces any map
      // assertion nor changes the required protected-tools production suites.
      // A failed semantic probe must not skip the next compiler's map tests.
      const nullProbe: Record<string, unknown> = {productionAccepted: false}; entry.nullMessageProbe = nullProbe;
      const nullExecutable = join(directory, 'null-message.exe');
      const nullArgs = ['-O2', '-Wall', '-Wextra', '-Werror', join(output, 'null-message.c'), '-o', nullExecutable,
        ...(sdk ? [] : ['-static'])];
      nullProbe.command = [compiler.path, ...nullArgs];
      const nullCompiled = await execute(`compile-null-${compiler.name}`, compiler.path, nullArgs);
      nullProbe.compile = nullCompiled;
      if (nullCompiled.code !== 0 || nullCompiled.timedOut) exitCode = 1;
      else {
        hashes[`${compiler.name}/null-message.exe`] = sha256(readFileSync(nullExecutable));
        if (!compileOnly) {
          const tested = await execute(`null-message-${compiler.name}`, nullExecutable, [], selectedEnvironment({
            HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
          }));
          nullProbe.native = tested; nullProbe.ordinarySemanticsAccepted = acceptsNullMessageProbe(tested);
          if (!nullProbe.ordinarySemanticsAccepted) exitCode = 1;
        }
      }
    } catch (error) { entry.error = String(error); exitCode = 1; }
    finally {
      try {await rootService?.stop();} catch (error) {entry.rootServiceError = String(error); exitCode = 1;}
      try {await procs.killAll(); await procs.close(); journal.close();}
      catch (error) {entry.cleanupError = String(error); exitCode = 1;}
      procs = undefined; trace?.stop();
      if (ownership) {
        const summary = summarizeOwnership(traceDirectory); entry.ownership = summary;
        writeFileSync(join(traceDirectory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
        if (!summary.complete) exitCode = 1;
      }
    }
    save(); writeFileSync(join(output, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
  }
} catch (error) { manifest.error = String(error); exitCode = 1; }
finally {
  try { if (procs) {await procs.killAll(); await procs.close();} trace?.stop(); rmSync(scratch, {recursive: true, force: true}); }
  catch (error) { manifest.cleanupError = String(error); exitCode = 1; }
  manifest.buildStateExists = existsSync(scratch); manifest.exitCode = exitCode; save();
}
console.log(`DEBUG_MAP_DIAGNOSTIC exit=${exitCode} native=${enabled && !compileOnly} productionAccepted=false`);
process.exitCode = exitCode;
