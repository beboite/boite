import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../../packages/ui');
const requireUi = createRequire(join(root, 'package.json'));
const { build, createServer, preview } = await import(requireUi.resolve('vite'));
const fixtureDir = join(import.meta.dir, '../.artifacts/fake-ui');
let fixtureBuild: Promise<unknown> | undefined;

/** Build fake-client fixtures once in CI, keeping cold transforms outside browser interaction deadlines. */
export async function startUi(port: number, options: { sourceModules?: boolean } = {}): Promise<{ close(): Promise<void> }> {
  const address = { host: '127.0.0.1', port, strictPort: true };
  if (process.env.BOITE_E2E_PREBUILT_UI === '1' && !options.sourceModules) {
    // Production intentionally excludes ?fake=1. This separate test bundle
    // enables it without changing the UI staged in the installer.
    fixtureBuild ??= build({ root, define: { 'import.meta.env.DEV': 'true' }, build: { outDir: fixtureDir, emptyOutDir: true }, logLevel: 'warn' });
    await fixtureBuild;
    return preview({ root, build: { outDir: fixtureDir }, preview: address, clearScreen: false });
  }
  const server = await createServer({ root, server: address, clearScreen: false });
  await server.listen();
  if (options.sourceModules) {
    // Source-importing tests need the dev server, but compilation belongs in
    // setup rather than inside the browser's navigation deadline.
    try {
      await Promise.all(['/src/main.ts', '/src/lib/fake-client.ts'].map(url => server.environments.client.warmupRequest(url)));
      await server.environments.client.waitForRequestsIdle();
    } catch (error) { await server.close(); throw error; }
  }
  return server;
}
