// Run once before `bun test tests/e2e`. On a fresh checkout the first
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

async function preparationStep<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  console.log(`e2e preparation: ${label} started`);
  try {
    const result = await run();
    console.log(`e2e preparation: ${label} finished in ${Math.round(performance.now() - started)} ms`);
    return result;
  } catch (error) {
    console.error(`e2e preparation: ${label} failed`, error);
    throw error;
  }
}

async function prepare(): Promise<void> {
  const root = join(import.meta.dir, '../../../packages/ui');
  const { build, createServer } = await preparationStep('load Vite', () =>
    import(createRequire(join(root, 'package.json')).resolve('vite')));
  const { fixtureBridge } = await preparationStep('load fixture bridge', () => import('./ui.ts'));

  // Match startDevUi's plugins: Vite hashes them into the optimized-dependency cache.
  const server = await preparationStep('create dev server', async () =>
    createServer({ root, plugins: [fixtureBridge], server: { host: '127.0.0.1', port: await freePort(), strictPort: true }, clearScreen: false }));
  try {
    await preparationStep('listen', () => server.listen());
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!base) throw new Error('the warm-up dev server reported no local URL');
    const entry = await preparationStep('transform entry', async () => {
      const response = await fetch(`${base}/src/main.ts`);
      if (!response.ok) throw new Error(`the dev server answered ${response.status} for /src/main.ts`);
      return response.text();
    });
    const dep = /["'](\/node_modules\/\.vite\/deps\/[^"'?]+\.js\?v=[^"']+)["']/.exec(entry)?.[1];
    if (!dep) throw new Error('/src/main.ts imports no optimized dependency; the warm-up found nothing to wait for');
    // Read the response body too: shutdown must not wait for an unread request.
    await preparationStep('optimized dependency', async () => {
      const response = await fetch(`${base}${dep}`);
      if (!response.ok) throw new Error(`the dev server answered ${response.status} for ${dep}`);
      await response.arrayBuffer();
    });
  } finally {
    await preparationStep('close dev server', () => server.close());
  }

  const outDir = process.argv[2];
  if (outDir) {
    await preparationStep('build fake UI', async () => {
      await build({ root, plugins: [fixtureBridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir: resolve(outDir), emptyOutDir: true }, logLevel: 'warn' });
    });
  }
}

try {
  await prepare();
  // Vite can retain handles after every preparation step has completed.
  // This standalone script has awaited the build and closed its server.
  process.exit(0);
} catch (error) {
  console.error(error);
  // A failed Vite operation may still own handles. This is a standalone script.
  process.exit(1);
}
