/**
 * Puts the compiled core where `tauri build --config src-tauri/tauri.bundle.conf.json`
 * expects it: `src-tauri/binaries/boite-core-<target triple>.exe` for `bundle.externalBin`,
 * and `src-tauri/binaries/jobs-worker.js` for the `bundle.resources` entry that lands it
 * beside the installed sidecar (without it the trace degrades from `events` to `poll`).
 *
 * Run from the repository root: `bun run apps/shell/scripts/stage-sidecar.ts`.
 */
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
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

const triple = TRIPLES[process.platform]?.[process.arch];
if (triple === undefined) {
  refuse(
    `no target triple for ${process.platform} ${process.arch}. ` +
      `apps/shell/scripts/stage-sidecar.ts knows ${Object.entries(TRIPLES)
        .flatMap(([platform, arches]) => Object.keys(arches).map((arch) => `${platform} ${arch}`))
        .join(', ')} only; add this one to its TRIPLES table.`,
  );
}

const exeSource = join(coreDist, 'boite-core.exe');
const workerSource = join(coreDist, 'jobs-worker.js');
const exeBytes = sizeOf(exeSource, `${exeSource} does not exist. Build it first: bun run build:core:exe`);
const workerBytes = sizeOf(
  workerSource,
  `${workerSource} does not exist. Build it first: bun run build:core:exe`,
);

mkdirSync(binaries, { recursive: true });
const exeTarget = join(binaries, `boite-core-${triple}.exe`);
const workerTarget = join(binaries, 'jobs-worker.js');
copyFileSync(exeSource, exeTarget);
copyFileSync(workerSource, workerTarget);

console.log(`stage-sidecar: ${exeTarget} (${exeBytes} bytes)`);
console.log(`stage-sidecar: ${workerTarget} (${workerBytes} bytes)`);
