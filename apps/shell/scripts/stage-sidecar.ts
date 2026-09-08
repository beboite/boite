/**
 * Puts the compiled core where the two things that run it expect it.
 *
 * `tauri build --config src-tauri/tauri.bundle.conf.json` wants
 * `src-tauri/binaries/boite-core-<target triple>.exe` for `bundle.externalBin`,
 * and `src-tauri/binaries/jobs-worker.js` for the `bundle.resources` entry that
 * lands it beside the installed sidecar (without it the trace degrades from
 * `events` to `poll`).
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
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only the platforms whose compiled core this repository actually produces. */
const TRIPLES: Record<string, Record<string, string>> = {
  win32: { x64: 'x86_64-pc-windows-msvc' },
};

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

/**
 * The one copy both destinations share: the compiled core under `exeName`, and
 * `jobs-worker.js` beside it under its own name, which is the only name the
 * core looks for.
 */
export function stageCore(targetDir: string, exeName: string): void {
  const exeSource = join(coreDist, process.platform === 'win32' ? 'boite-core.exe' : 'boite-core');
  const workerSource = join(coreDist, 'jobs-worker.js');
  const exeBytes = sizeOf(exeSource, `${exeSource} does not exist. Build it first: bun run build:core:exe`);
  const workerBytes = sizeOf(
    workerSource,
    `${workerSource} does not exist. Build it first: bun run build:core:exe`,
  );

  mkdirSync(targetDir, { recursive: true });
  const exeTarget = join(targetDir, exeName);
  const workerTarget = join(targetDir, 'jobs-worker.js');
  copyFileSync(exeSource, exeTarget);
  copyFileSync(workerSource, workerTarget);

  console.log(`stage-sidecar: ${exeTarget} (${exeBytes} bytes)`);
  console.log(`stage-sidecar: ${workerTarget} (${workerBytes} bytes)`);
}

const triple = TRIPLES[process.platform]?.[process.arch];
if (triple === undefined) {
  refuse(
    `no target triple for ${process.platform} ${process.arch}. ` +
      `apps/shell/scripts/stage-sidecar.ts knows ${Object.entries(TRIPLES)
        .flatMap(([platform, arches]) => Object.keys(arches).map((arch) => `${platform} ${arch}`))
        .join(', ')} only; add this one to its TRIPLES table.`,
  );
}

const suffix = process.platform === 'win32' ? '.exe' : '';
stageCore(binaries, `boite-core-${triple}${suffix}`);

if (existsSync(shellExe)) {
  stageCore(release, `boite-core${suffix}`);
} else {
  console.log(
    `stage-sidecar: ${shellExe} does not exist, nothing staged beside it. ` +
      'Build it with `bun run --cwd apps/shell tauri build --no-bundle`.',
  );
}
