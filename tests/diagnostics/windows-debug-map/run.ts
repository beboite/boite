import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir, release} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {capture, type Captured} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {sha256, sourceHash, sourcePath, writeSource} from './generate.ts';

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
const {Journal} = await import('../../../packages/core/src/journal.ts');
const {Bus} = await import('../../../packages/core/src/bus.ts');
const {ProcRegistry} = await import('../../../packages/core/src/procs.ts');
const scratch = mkdtempSync(join(tmpdir(), 'boite-debug-map-build-'));
const journal = new Journal(join(scratch, 'journal.db')), procs = new ProcRegistry(journal, new Bus());
let exitCode = 0;
try {
  const hashes = writeSource(output); manifest.sourceHashes = hashes;
  for (const file of ['generate.ts', 'run.ts', 'routing.test.ts', 'environment.ts', 'capture.ts', 'gates.md']) {
    hashes[file] = sha256(readFileSync(join(import.meta.dir, file)));
  }
  writeFileSync(join(output, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n'); save();
  const compilers = process.platform === 'win32'
    ? [{name: 'sdk', path: Bun.which('clang')}, {name: 'mingw', path: 'C:\\mingw64\\bin\\gcc.exe'}]
    : [{name: 'mingw-cross', path: Bun.which('x86_64-w64-mingw32-gcc')}];
  async function execute(id: string, executable: string, args: string[], env = selectedEnvironment()) {
    const child = procs.spawnPiped(id, executable, args, {cwd: output, env, agentRoot: false});
    const result = await capture(procs, id, child, id.startsWith('compile') ? 90000 : 110000);
    writeFileSync(join(output!, `${id}.log`), `pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    console.log(`${id}: pid=${result.pid} exit=${result.code} timedOut=${result.timedOut}\n${result.out}${result.err}`);
    return result;
  }
  for (const compiler of compilers) {
    const entry: Record<string, unknown> = {compiler: compiler.path, name: compiler.name}; results.push(entry);
    try {
      if (!compiler.path || !existsSync(compiler.path)) throw new Error(`compiler unavailable: ${compiler.name}`);
      const directory = join(output, compiler.name); mkdirSync(directory);
      const helper = join(directory, 'debug-map.exe');
      const sdk = process.platform === 'win32' && /clang/i.test(compiler.path);
      const args = ['-O2', '-Wall', '-Wextra', '-Werror', join(output, 'debug-map.c'), '-o', helper,
        ...(sdk ? [] : ['-static']), '-luserenv', '-ladvapi32', '-lshell32', '-luser32'];
      entry.command = [compiler.path, ...args];
      const compiled = await execute(`compile-${compiler.name}`, compiler.path, args); entry.compile = compiled;
      if (compiled.code !== 0 || compiled.timedOut) throw new Error(`strict compile failed: ${compiler.name}`);
      hashes[`${compiler.name}/debug-map.exe`] = sha256(readFileSync(helper));
      if (!compileOnly) {
        const tested: Captured = await execute(`native-${compiler.name}`, process.execPath,
          ['test', join(import.meta.dir, 'routing.test.ts'), '--timeout', '90000'], selectedEnvironment({
            BOITE_TEST_DEBUG_MAP: '1', BOITE_DEBUG_MAP_HELPER: helper, BOITE_DEBUG_MAP_OUTPUT: directory,
            HOME: scratch, USERPROFILE: scratch, APPDATA: scratch, LOCALAPPDATA: scratch,
          }));
        entry.native = tested;
        if (tested.code !== 0 || tested.timedOut) exitCode = 1;
        if (!existsSync(join(directory, 'results.json'))) { entry.missingNativeResults = true; exitCode = 1; }
        else if (JSON.parse(readFileSync(join(directory, 'results.json'), 'utf8')).initialGatePassed !== true) exitCode = 1;
      }
    } catch (error) { entry.error = String(error); exitCode = 1; }
    save(); writeFileSync(join(output, 'sha256.json'), JSON.stringify(hashes, null, 2) + '\n');
  }
} catch (error) { manifest.error = String(error); exitCode = 1; }
finally {
  try { await procs.killAll(); await procs.close(); journal.close(); rmSync(scratch, {recursive: true, force: true}); }
  catch (error) { manifest.cleanupError = String(error); exitCode = 1; }
  manifest.buildStateExists = existsSync(scratch); manifest.exitCode = exitCode; save();
}
console.log(`DEBUG_MAP_DIAGNOSTIC exit=${exitCode} native=${enabled && !compileOnly} productionAccepted=false`);
process.exitCode = exitCode;
