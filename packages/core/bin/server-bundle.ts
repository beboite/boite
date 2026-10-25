import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';

/** Resolves fflate from the core workspace that owns this dependency. */
export function serverBundle(core: string, ui: string, version: string): Uint8Array {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Server bundle version must be a semantic version');
  const entries: Record<string, Uint8Array> = {
    'boite-core': readFileSync(core),
    'boite': readFileSync(join(import.meta.dir, '../shims/boite')),
    'server-release.json': Buffer.from(JSON.stringify({ version })),
  };
  addTree(entries, ui, 'ui/');
  if (!entries['ui/index.html']) throw new Error('Server UI bundle is missing index.html');
  return zipSync(entries, { level: 6 });
}

/** The Bun pin of apps/android-server/termux/install.sh, which every Android release runs on. */
export function androidBunPin(installer: string): { version: string; sha256: string } {
  const version = /^BUN_VERSION=(\d+\.\d+\.\d+)$/m.exec(installer)?.[1];
  const sha256 = /^BUN_SHA256=([0-9a-f]{64})$/m.exec(installer)?.[1];
  if (!version || !sha256) throw new Error('install.sh must set BUN_VERSION=<x.y.z> and BUN_SHA256=<64 hex digits>');
  return { version, sha256 };
}

/**
 * The Android server: Bun compiles no Android executable, so the core ships as
 * the scripts of `bun run build`, run by the Bun the bundle names, with the
 * controller that installs and supervises it in Termux (docs/android-server.md).
 */
export function androidServerBundle(dist: string, ui: string, termux: string, version: string): Uint8Array {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Server bundle version must be a semantic version');
  const bun = androidBunPin(readFileSync(join(termux, 'install.sh'), 'utf8'));
  const entries: Record<string, Uint8Array> = {
    'boite-server.ts': readFileSync(join(termux, 'boite-server.ts')),
    'server-release.json': Buffer.from(JSON.stringify({ version, bun })),
    // The echo provider's login script, which the core finds beside its scripts (Dockerfile).
    'core/shipped/echo-login.ts': readFileSync(join(import.meta.dir, '../src/providers/shipped/echo-login.ts')),
  };
  for (const entry of readdirSync(dist, { withFileTypes: true })) {
    // The compiled executables of other platforms stay out; the scripts and their assets go in.
    if (!entry.isFile() || entry.name.startsWith('boite-core')) continue;
    entries[`core/${entry.name}`] = readFileSync(join(dist, entry.name));
  }
  if (!entries['core/main.js']) throw new Error(`${dist} has no main.js: run bun run build:core first`);
  addTree(entries, ui, 'ui/');
  if (!entries['ui/index.html']) throw new Error('Server UI bundle is missing index.html');
  return zipSync(entries, { level: 6 });
}

function addTree(entries: Record<string, Uint8Array>, directory: string, prefix: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Server UI bundle must not contain symlinks: ${file}`);
    if (entry.isDirectory()) addTree(entries, file, `${prefix}${entry.name}/`);
    else if (entry.isFile()) entries[`${prefix}${entry.name}`] = readFileSync(file);
    else throw new Error(`Expected a regular server UI file: ${file}`);
  }
}
