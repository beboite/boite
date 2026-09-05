/**
 * The core, from the bundle when `bun run build` has produced one and from the
 * sources otherwise. Both entries export `main` and only start themselves when
 * they are the process entry point, so the launcher calls it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface Entry {
  main(argv: string[]): void;
}

const bundle = join(import.meta.dir, '..', 'dist', 'main.js');
const specifier = existsSync(bundle) ? pathToFileURL(bundle).href : '../src/main.ts';
const entry = (await import(specifier)) as Entry;
entry.main(process.argv.slice(2));
