/**
 * Puts the core where the two things that run it expect it.
 *
 * On Windows the sidecar is the Bun runtime itself, copied under the name
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
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requirePinnedBun } from '../../../scripts/ci/bun-version.ts';
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

/** The executable staged as the sidecar: the Bun running this script on Windows, the compiled core elsewhere. */
function sidecarSource(): string {
  if (!RUNTIME_SIDECAR) return join(coreDist, 'boite-core');
  const runtime = process.execPath;
  if (!/^bun(?:-profile)?\.exe$/i.test(basename(runtime))) {
    refuse(`this script runs under ${runtime}; expected bun.exe, which is staged as the sidecar`);
  }
  requirePinnedBun('the staged sidecar');
  const signature = Bun.spawnSync(
    ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(Get-AuthenticodeSignature -LiteralPath '${runtime.replaceAll("'", "''")}').Status`],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  );
  const status = signature.stdout.toString().trim();
  if (status !== 'Valid') {
    console.warn(`stage-sidecar: ${runtime} has signature status "${status}", expected "Valid". An unsigned runtime starts as slowly as a compiled core.`);
  }
  return runtime;
}

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
  const exeSource = sidecarSource();
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
