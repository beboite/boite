import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = join(import.meta.dir, '../../../packages/ui');
const requireUi = createRequire(join(root, 'package.json'));
const { build, createServer, preview } = await import(requireUi.resolve('vite'));
// One directory per process: `bun test --parallel` runs files in several
// workers, and a shared one would be emptied under another worker's server.
const fixtureDir = join(import.meta.dir, `../.artifacts/fake-ui-${process.pid}`);
let fixtureBuild: Promise<unknown> | undefined;

/** Build fake-client fixtures once in CI, keeping cold transforms outside browser interaction deadlines. */
export async function startUi(port: number, options: { development?: boolean } = {}): Promise<{ close(): Promise<void> }> {
  const address = { host: '127.0.0.1', port, strictPort: true };
  const shared = process.env.BOITE_E2E_FAKE_UI;
  if (shared && !options.development) {
    // Built once by `lib/warm.ts` before a parallel run.
    if (!existsSync(join(shared, 'index.html'))) throw new Error(`BOITE_E2E_FAKE_UI=${shared} holds no index.html; build it with bun tests/e2e/lib/warm.ts ${shared}`);
    return preview({ root, build: { outDir: resolve(shared) }, preview: address, clearScreen: false });
  }
  if (process.env.BOITE_E2E_PREBUILT_UI === '1' && !options.development) {
    // Production intentionally excludes ?fake=1. This separate test bundle
    // enables it without changing the UI staged in the installer.
    fixtureBuild ??= build({ root, define: { 'import.meta.env.DEV': 'true' }, build: { outDir: fixtureDir, emptyOutDir: true }, logLevel: 'warn' });
    await fixtureBuild;
    return preview({ root, build: { outDir: fixtureDir }, preview: address, clearScreen: false });
  }
  const server = await createServer({ root, server: address, clearScreen: false });
  await server.listen();
  if (options.development) {
    // Source-importing tests need the dev server, but compilation belongs in
    // setup rather than inside the browser's navigation deadline.
    try {
      await Promise.all(['/src/main.ts', '/src/lib/fake-client.ts'].map(async url => {
        if (!await server.environments.client.transformRequest(url)) throw new Error(`UI setup could not transform ${url}`);
      }));
      await server.environments.client.waitForRequestsIdle();
    } catch (error) { await server.close(); throw error; }
  }
  return server;
}
