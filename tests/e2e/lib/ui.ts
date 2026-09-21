import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dir, '../../../packages/ui');
const requireUi = createRequire(join(root, 'package.json'));
const { build, createServer, preview } = await import(requireUi.resolve('vite'));
const fixtureDir = join(import.meta.dir, '../.artifacts/fake-ui');
let fixtureBuild: Promise<unknown> | undefined;
// Expose fixture controls in both Vite modes without putting test hooks in the shipped UI.
const fixtureBridge = {
  name: 'boite-e2e-fixture-controls',
  transform(code: string, id: string) {
    if (id.replaceAll('\\', '/') !== join(root, 'src/main.ts').replaceAll('\\', '/')) return;
    return `${code}\nimport { workspace } from './lib/workspace.svelte.ts';\nimport { setTheme } from './lib/theme.ts';\nglobalThis.__boiteTest = { workspace, setTheme };\n`;
  },
};

/** Build fake-client fixtures once in CI, keeping cold transforms outside browser interaction deadlines. */
export async function startUi(port: number): Promise<{ close(): Promise<void> }> {
  const address = { host: '127.0.0.1', port, strictPort: true };
  if (process.env.BOITE_E2E_PREBUILT_UI === '1') {
    // Production intentionally excludes ?fake=1. This separate test bundle
    // enables it without changing the UI staged in the installer.
    fixtureBuild ??= build({ root, plugins: [fixtureBridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir: fixtureDir, emptyOutDir: true }, logLevel: 'warn' });
    await fixtureBuild;
    return preview({ root, build: { outDir: fixtureDir }, preview: address, clearScreen: false });
  }
  const server = await createServer({ root, plugins: [fixtureBridge], server: address, clearScreen: false });
  await server.listen();
  return server;
}
