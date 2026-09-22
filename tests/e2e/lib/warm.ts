// Run once before `bun test tests/e2e --parallel`. On a fresh checkout the first
// Vite dev server forces a dependency optimization that empties
// `packages/ui/node_modules/.vite`, and workers starting together empty it under
// each other's servers. One optimization here leaves every later server a
// consistent cache. With an output directory argument it also builds the
// fake-client bundle once, for `BOITE_E2E_FAKE_UI`.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { freePort } from './cdp.ts';

// Vite hashes NODE_ENV into the cache it checks. `bun test` sets it to `test`;
// warmed under any other value, the first test server would optimize again.
process.env.NODE_ENV = 'test';

const root = join(import.meta.dir, '../../../packages/ui');
const { build, createServer } = await import(createRequire(join(root, 'package.json')).resolve('vite'));

// Without strictPort Vite moves to the next port if this one was taken since.
const server = await createServer({ root, server: { host: '127.0.0.1', port: await freePort() }, clearScreen: false });
await server.listen();
try {
  const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
  if (!base) throw new Error('the warm-up dev server reported no local URL');
  const entry = await fetch(`${base}/src/main.ts`);
  if (!entry.ok) throw new Error(`the dev server answered ${entry.status} for /src/main.ts`);
  const dep = /["'](\/node_modules\/\.vite\/deps\/[^"'?]+\.js\?v=[^"']+)["']/.exec(await entry.text())?.[1];
  if (!dep) throw new Error('/src/main.ts imports no optimized dependency; the warm-up found nothing to wait for');
  // The optimized file is served once the optimizer has written the whole cache.
  const optimized = await fetch(`${base}${dep}`);
  if (!optimized.ok) throw new Error(`the dev server answered ${optimized.status} for ${dep}`);
} finally {
  await server.close();
}

const outDir = process.argv[2];
if (outDir) {
  await build({ root, define: { 'import.meta.env.DEV': 'true' }, build: { outDir: resolve(outDir), emptyOutDir: true }, logLevel: 'warn' });
}
