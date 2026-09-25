/**
 * Puts the core where the two things that run it expect it.
 *
 * On Windows the sidecar is the Bun runtime itself, in its baseline build that
 * needs no AVX2, copied under the name
 * `boite-core.exe`, with the bundled core in a `core` directory beside it; the
 * shell starts it as `boite-core.exe core/main.js`. The runtime carries its
 * publisher's signature and the output of `bun build --compile` carries none,
 * which Windows 11 makes it pay for at every start: see "Known cost" in
 * `docs/performance.md`. Everywhere else the sidecar is the compiled core.
 *
 * `tauri build --config src-tauri/tauri.bundle.conf.json` wants
 * `src-tauri/binaries/boite-core-<target triple>.exe` for `bundle.externalBin`,
 * and `src-tauri/binaries/jobs-worker.js` plus
 * `src-tauri/binaries/guard-worker.js` for the `bundle.resources` entries that
 * land them beside the installed sidecar (without the first the trace degrades
 * from `events` to `poll`, without the second the focus guard never starts).
 *
 * The shell exe in `src-tauri/target/release` runs whatever `boite-core.exe`
 * sits beside it (`resolve_core` in `src-tauri/src/lib.rs`), which is what the
 * end to end suite drives, so the copy goes there too whenever that exe exists.
 * `tests/e2e/shell.test.ts` refuses a sidecar older than the core sources and
 * names the fix, `bun run stage:core`, which is this script after
 * `bun run build:core:exe`.
 *
 * Run from the repository root: `bun run apps/shell/scripts/stage-sidecar.ts`.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSignature, signatureProblem } from './runtime-signature.ts';
import { nativeTarget } from './targets.ts';

/** Only the platforms whose compiled core this repository actually produces. */
const { triple, suffix } = nativeTarget();

const here = dirname(fileURLToPath(import.meta.url));
const shell = resolve(here, '..');
const repo = resolve(shell, '..', '..');
const coreDist = join(repo, 'packages', 'core', 'dist');
const binaries = join(shell, 'src-tauri', 'binaries');
const release = join(shell, 'src-tauri', 'target', 'release');
const shellExe = join(release, process.platform === 'win32' ? 'boite-shell.exe' : 'boite-shell');

function refuse(message: string): never {
  console.error(`stage-sidecar: ${message}`);
  process.exit(1);
}

function sizeOf(path: string, missing: string): number {
  try {
    return statSync(path).size;
  } catch {
    return refuse(missing);
  }
}

/** The Worker files the compiled core loads by name from beside its executable. */
const WORKERS = ['jobs-worker.js', 'guard-worker.js'];
/** The `boite` shims a thread's PATH reaches: each runs `boite-core cli` from beside itself. */
const SHIMS = ['boite', 'boite.cmd'];
const shims = join(repo, 'packages', 'core', 'shims');

/** Windows only: the sidecar is the runtime, and the bundle it runs goes in this directory beside it. */
const RUNTIME_SIDECAR = process.platform === 'win32';
const BUNDLE_DIR = 'core';

/**
 * Bun's baseline runtime for Windows x64, of the version running this script.
 * The default build needs AVX2 and stops with an illegal instruction on a CPU
 * without it, before the core's first line; the baseline one runs on every x64
 * CPU, starts as fast and carries the same signature (docs/performance.md). It
 * is downloaded once, checked against the release's SHASUMS256.txt and kept
 * under `node_modules/.cache`. The checksum comes from the same release, so the
 * publisher's signature is what vouches for the file: it is checked on the
 * download and again on the cached copy at every staging, and a runtime that is
 * not validly signed by Bun's publisher is refused.
 */
async function baselineRuntime(): Promise<string> {
  const name = 'bun-windows-x64-baseline';
  const dir = join(repo, 'node_modules', '.cache', 'boite-bun-runtime', `${name}-v${Bun.version}`);
  const exe = join(dir, 'bun.exe');
  if (existsSync(exe)) {
    const cached = signatureProblem(exe, readSignature(exe));
    if (cached === null) return exe;
    console.warn(`stage-sidecar: ${cached}; downloading it again`);
    rmSync(dir, { recursive: true, force: true });
  }
  const release = `https://github.com/oven-sh/bun/releases/download/bun-v${Bun.version}`;
  const download = async (file: string): Promise<Response> => {
    const response = await fetch(`${release}/${file}`, { signal: AbortSignal.timeout(300_000) }).catch((error: unknown) =>
      refuse(`could not download ${release}/${file}: ${error instanceof Error ? error.message : String(error)}`));
    if (!response.ok) refuse(`${release}/${file} answered ${response.status}`);
    return response;
  };
  const sums = await (await download('SHASUMS256.txt')).text();
  const expected = sums.split('\n').map((line) => line.trim().split(/\s+/)).find(([, file]) => file === `${name}.zip`)?.[0];
  if (expected === undefined) refuse(`${release}/SHASUMS256.txt lists no ${name}.zip`);
  const zip = new Uint8Array(await (await download(`${name}.zip`)).arrayBuffer());
  const actual = new Bun.CryptoHasher('sha256').update(zip).digest('hex');
  if (actual !== expected) refuse(`${name}.zip has SHA-256 ${actual}, SHASUMS256.txt says ${expected}`);

  // Unpacked beside the cache entry and renamed into it, so a cut download never counts as cached.
  const scratch = `${dir}.partial`;
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const archive = join(scratch, `${name}.zip`);
  await Bun.write(archive, zip);
  // Windows' own bsdtar reads zip archives; a Git for Windows tar earlier on PATH does not.
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const unpacked = Bun.spawnSync([tar, '-xf', archive, '-C', scratch], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  if (unpacked.exitCode !== 0) refuse(`${tar} could not unpack ${archive}: ${unpacked.stderr.toString()}`);
  const extracted = join(scratch, name, 'bun.exe');
  if (!existsSync(extracted)) refuse(`${name}.zip has no ${name}/bun.exe`);
  const problem = signatureProblem(extracted, readSignature(extracted));
  if (problem !== null) {
    rmSync(scratch, { recursive: true, force: true });
    refuse(`${problem}. The download is not staged.`);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  renameSync(extracted, exe);
  rmSync(scratch, { recursive: true, force: true });
  console.log(`stage-sidecar: ${exe} (Bun ${Bun.version} baseline, SHA-256 of the archive and signature checked)`);
  return exe;
}

/** The executable staged as the sidecar: Bun's baseline runtime on Windows, the compiled core elsewhere. */
const sidecar = RUNTIME_SIDECAR ? await baselineRuntime() : join(coreDist, 'boite-core');


/** Every file of the bundle but the Workers, which stay beside the executable where the core looks first. */
function stageBundle(targetDir: string): void {
  const bundle = join(targetDir, BUNDLE_DIR);
  // Chunk names carry a hash: what an earlier build left would never be loaded, only shipped.
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(bundle, { recursive: true });
  const files = readdirSync(coreDist).filter((name) => name.endsWith('.js') && !WORKERS.includes(name));
  if (!files.includes('main.js')) refuse(`${join(coreDist, 'main.js')} does not exist. Build it first: bun run build:core`);
  let bytes = 0;
  for (const name of files) {
    copyFileSync(join(coreDist, name), join(bundle, name));
    bytes += statSync(join(bundle, name)).size;
  }
  console.log(`stage-sidecar: ${bundle} (${files.length} files, ${bytes} bytes)`);
}

/**
 * The one copy both destinations share: the sidecar under `exeName`,
 * every Worker beside it under its own name, which is the only name the core
 * looks for, and the two `boite` shims the core puts on an agent's PATH.
 */
export function stageCore(targetDir: string, exeName: string): void {
  const exeSource = sidecar;
  const exeBytes = sizeOf(exeSource, `${exeSource} does not exist. Build it first: bun run build:core:exe`);
  const workers = WORKERS.map((name) => {
    const source = join(coreDist, name);
    return {
      name,
      source,
      bytes: sizeOf(source, `${source} does not exist. Build it first: bun run build:core`),
    };
  });

  mkdirSync(targetDir, { recursive: true });
  const exeTarget = join(targetDir, exeName);
  copyFileSync(exeSource, exeTarget);
  // Windows keeps the source's modification time on a copy, and the end to end suite reads it to refuse a stale sidecar.
  utimesSync(exeTarget, new Date(), new Date());
  console.log(`stage-sidecar: ${exeTarget} (${exeBytes} bytes)`);
  if (RUNTIME_SIDECAR) stageBundle(targetDir);
  for (const worker of workers) {
    const target = join(targetDir, worker.name);
    copyFileSync(worker.source, target);
    console.log(`stage-sidecar: ${target} (${worker.bytes} bytes)`);
  }
  for (const name of SHIMS) {
    const source = join(shims, name);
    const bytes = sizeOf(source, `${source} does not exist; the shims are tracked in packages/core/shims`);
    const target = join(targetDir, name);
    copyFileSync(source, target);
    if (process.platform !== 'win32' && name === 'boite') chmodSync(target, 0o755);
    console.log(`stage-sidecar: ${target} (${bytes} bytes)`);
  }
}

stageCore(binaries, `boite-core-${triple}${suffix}`);

// Cargo may use a shared target directory. Snapshot its shell into this
// checkout so a later build elsewhere cannot replace the executable under test.
const metadata = Bun.spawnSync(['cargo', 'metadata', '--no-deps', '--format-version', '1', '--manifest-path', join(shell, 'src-tauri', 'Cargo.toml')], {
  stdout: 'pipe', stderr: 'pipe', windowsHide: true,
});
if (metadata.exitCode !== 0) refuse(`cargo metadata failed: ${metadata.stderr.toString()}`);
const target = JSON.parse(metadata.stdout.toString()).target_directory as string;
const builtShell = join(target, 'release', `boite-shell${suffix}`);
if (resolve(builtShell) !== resolve(shellExe) && existsSync(builtShell)) {
  mkdirSync(release, { recursive: true });
  copyFileSync(builtShell, shellExe);
  console.log(`stage-sidecar: shell snapshot ${shellExe}`);
}

if (existsSync(shellExe)) {
  stageCore(release, `boite-core${suffix}`);
} else {
  console.log(
    `stage-sidecar: ${shellExe} does not exist, nothing staged beside it. ` +
      'Build it with `bun run --cwd apps/shell tauri build --no-bundle`.',
  );
}
