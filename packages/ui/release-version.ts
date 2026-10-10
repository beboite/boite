import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This file's folder: Vitest's jsdom files have no `file:` URL, but they have `import.meta.dirname`. */
const here: string = typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url));

/**
 * The release this build belongs to, as the root package.json says: the
 * nightly build stamps it there (`scripts/ci/nightly-build.ts`). Vite defines
 * it as `__BOITE_VERSION__`, and the tests' setup sets the same global.
 */
export function releaseVersion(rootPackage: string = join(here, '..', '..', 'package.json')): string {
  const version = (JSON.parse(readFileSync(rootPackage, 'utf8')) as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '') throw new Error('package.json at the repository root has no version');
  return version;
}
