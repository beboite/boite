import { readFileSync } from 'node:fs';

/**
 * The release this build belongs to, as the root package.json says: the
 * nightly build stamps it there (`scripts/ci/nightly-build.ts`). Vite and
 * Vitest both define it as `__BOITE_VERSION__`.
 */
export function releaseVersion(rootPackage: string | URL = new URL('../../package.json', import.meta.url)): string {
  const version = (JSON.parse(readFileSync(rootPackage, 'utf8')) as { version?: unknown }).version;
  if (typeof version !== 'string' || version === '') throw new Error('package.json at the repository root has no version');
  return version;
}
