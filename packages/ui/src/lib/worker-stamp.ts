/**
 * `public/sw.js` reaches the build as it is, so every build would ship the same
 * worker: the browser would never install a newer one, `activate` would never
 * run again, and each update's hashed files would pile up in one cache for
 * good. The build names the cache after what it emitted instead
 * (`vite.config.ts`), so a new build is a new worker whose `activate` deletes
 * the previous build's cache along with every chunk in it.
 */
const CACHE_LINE = /const CACHE = '(boite-ui-v\d+)';/;

export function stampWorkerCache(source: string, buildId: string): string {
  if (!/^[0-9a-f]{8,64}$/.test(buildId)) throw new Error(`the service worker build id must be 8 to 64 lowercase hex characters, got "${buildId}"`);
  const line = CACHE_LINE.exec(source);
  if (!line) throw new Error("public/sw.js must declare its cache as const CACHE = 'boite-ui-v<n>'; so the build can name it");
  return source.replace(CACHE_LINE, `const CACHE = '${line[1]}-${buildId}';`);
}
