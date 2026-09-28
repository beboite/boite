// Run once before `bun test tests/e2e`. On a fresh checkout the first
// Vite dev server forces a dependency optimization that empties
// `packages/ui/node_modules/.vite`, and workers starting together empty it under
// each other's servers. One optimization here leaves every later server a
// consistent cache. With an output directory argument it also builds the
// fake-client bundle once, for `BOITE_E2E_FAKE_UI`.
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { freePort } from './cdp.ts';
import { preparationStep } from './preparation.ts';

// Vite hashes NODE_ENV into the cache it checks. `bun test` sets it to `test`;
// warmed under any other value, the first test server would optimize again.
process.env.NODE_ENV = 'test';

async function prepare(): Promise<void> {
  const root = join(import.meta.dir, '../../../packages/ui');
  const { build, createServer } = await preparationStep('load Vite', () =>
    import(createRequire(join(root, 'package.json')).resolve('vite')));

  // Without strictPort Vite moves to the next port if this one was taken since.
  const server = await preparationStep('create dev server', async () =>
    createServer({ root, server: { host: '127.0.0.1', port: await freePort() }, clearScreen: false }));
  try {
    await preparationStep('listen', () => server.listen());
    const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '');
    if (!base) throw new Error('the warm-up dev server reported no local URL');
    const entry = await preparationStep('transform entry', async (signal) => {
      const response = await fetch(`${base}/src/main.ts`, { signal });
      if (!response.ok) throw new Error(`the dev server answered ${response.status} for /src/main.ts`);
      return response.text();
    });
    const dep = /["'](\/node_modules\/\.vite\/deps\/[^"'?]+\.js\?v=[^"']+)["']/.exec(entry)?.[1];
    if (!dep) throw new Error('/src/main.ts imports no optimized dependency; the warm-up found nothing to wait for');
    // Read the response body too: shutdown must not wait for an unread request.
    await preparationStep('optimized dependency', async (signal) => {
      const response = await fetch(`${base}${dep}`, { signal });
      if (!response.ok) throw new Error(`the dev server answered ${response.status} for ${dep}`);
      await response.arrayBuffer();
    });
  } finally {
    await preparationStep('close dev server', () => server.close(), 10_000);
  }

  const outDir = process.argv[2];
  if (outDir) {
    await preparationStep('build fake UI', async () => {
      const { fixtureBridge } = await import('./ui.ts');
      await build({ root, plugins: [fixtureBridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir: resolve(outDir), emptyOutDir: true }, logLevel: 'warn' });
    });
  }
}

try {
  await prepare();
} catch (error) {
  console.error(error);
  // A timed-out Vite operation may still own handles after its bounded close.
  // Do not leave this standalone preparation process alive until the job timeout.
  process.exit(1);
}
