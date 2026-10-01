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
  const add = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (lstatSync(file).isSymbolicLink()) throw new Error(`Server UI bundle must not contain symlinks: ${file}`);
      if (entry.isDirectory()) add(file, `${prefix}${entry.name}/`);
      else if (entry.isFile()) entries[`${prefix}${entry.name}`] = readFileSync(file);
      else throw new Error(`Expected a regular server UI file: ${file}`);
    }
  };
  add(ui, 'ui/');
  if (!entries['ui/index.html']) throw new Error('Server UI bundle is missing index.html');
  return zipSync(entries, { level: 6 });
}
