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
// Expose fixture controls in both Vite modes without putting test hooks in the shipped UI.
export const fixtureBridge = {
  name: 'boite-e2e-fixture-controls',
  transform(code: string, id: string) {
    if (id.replaceAll('\\', '/') !== join(root, 'src/main.ts').replaceAll('\\', '/')) return;
    return `${code}\nimport { workspace } from './lib/workspace.svelte.ts';\nimport { setTheme } from './lib/theme.ts';\nimport { appUpdater } from './lib/app-update.svelte.ts';\nglobalThis.__boiteTest = { workspace, setTheme, appUpdater };\n`;
  },
};

/**
 * `BOITE_E2E_TRACE=1`: the preview server times every request, and a failing
 * page's trace (`lib/cdp.ts`) says which ones it still owes and which took
 * over a second, to tell a server that never answered from a browser that
 * never read the answer.
 */
const traced = { open: new Map<number, { url: string; at: number }>(), slow: [] as string[], next: 0, served: 0 };
const requestTrace = {
  name: 'boite-e2e-request-trace',
  configurePreviewServer(server: { middlewares: { use(handler: (req: { url?: string }, res: { once(event: 'close', listener: () => void): void }, next: () => void) => void): void } }) {
    server.middlewares.use((req, res, next) => {
      const id = traced.next++, at = Date.now(), url = req.url ?? '?';
      traced.open.set(id, { url, at });
      res.once('close', () => {
        traced.open.delete(id);
        traced.served++;
        const ms = Date.now() - at;
        if (ms > 1_000) { traced.slow.push(`${url} ${ms} ms`); if (traced.slow.length > 10) traced.slow.shift(); }
      });
      next();
    });
  },
};
if (process.env.BOITE_E2E_TRACE === '1') {
  (globalThis as { __boiteUiTrace?: () => string }).__boiteUiTrace = () => {
    const now = Date.now();
    const open = [...traced.open.values()].map(request => `${request.url} for ${now - request.at} ms`).slice(0, 8);
    return `${traced.served} served; open: ${open.length ? open.join(', ') : 'none'}; over 1 s: ${traced.slow.length ? traced.slow.join(', ') : 'none'}`;
  };
}
const previewPlugins = process.env.BOITE_E2E_TRACE === '1' ? [requestTrace] : [];

/** Build fake-client fixtures once in CI, keeping cold transforms outside browser interaction deadlines. */
export async function startUi(port: number, options: { development?: boolean } = {}): Promise<{ close(): Promise<void> }> {
  const address = { host: '127.0.0.1', port, strictPort: true };
  const shared = process.env.BOITE_E2E_FAKE_UI;
  if (shared && !options.development) {
    // Built once by `lib/warm.ts` before a parallel run.
    if (!existsSync(join(shared, 'index.html'))) throw new Error(`BOITE_E2E_FAKE_UI=${shared} holds no index.html; build it with bun tests/e2e/lib/warm.ts ${shared}`);
    return preview({ root, plugins: previewPlugins, build: { outDir: resolve(shared) }, preview: address, clearScreen: false });
  }
  if (process.env.BOITE_E2E_PREBUILT_UI === '1' && !options.development) {
    // Production intentionally excludes ?fake=1. This separate test bundle
    // enables it without changing the UI staged in the installer.
    fixtureBuild ??= build({ root, plugins: [fixtureBridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir: fixtureDir, emptyOutDir: true }, logLevel: 'warn' });
    await fixtureBuild;
    return preview({ root, plugins: previewPlugins, build: { outDir: fixtureDir }, preview: address, clearScreen: false });
  }
  return startDevUi(port);
}

/**
 * A dev server, for a file whose page imports `/src/...` at run time: a built
 * bundle has no such URL. Every module the page can load is transformed before
 * this returns, so the cost lands in `beforeAll` and not in the first browser
 * launch. Cold, on a loaded Windows runner, that launch outran the 30 s a test
 * hook gets.
 */
export async function startDevUi(port: number): Promise<{ close(): Promise<void> }> {
  const server = await createServer({ root, plugins: [fixtureBridge], server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  try {
    await server.listen();
    await transformAll(server, '/src/main.ts');
  } catch (error) {
    await server.close();
    throw error;
  }
  return server;
}

/**
 * Walks the imports from `entry`, lazy ones included: 231 modules in 1.3 s on a
 * warm workstation (2026-09-24). Vite 8 leaves `TransformResult.deps` empty, so
 * the edges come from the module graph. Optimized dependencies are already on disk.
 */
interface DevServer {
  transformRequest(url: string): Promise<unknown>;
  environments: { client: { moduleGraph: { getModuleByUrl(url: string): Promise<{ importedModules: Set<{ url: string }> } | undefined> } } };
}

async function transformAll(server: DevServer, entry: string): Promise<void> {
  const graph = server.environments.client.moduleGraph;
  const seen = new Set<string>();
  let wave = [entry];
  while (wave.length > 0) {
    const next: string[] = [];
    await Promise.all(wave.map(async (url) => {
      if (seen.has(url)) return;
      seen.add(url);
      await server.transformRequest(url);
      for (const imported of (await graph.getModuleByUrl(url))?.importedModules ?? []) {
        if (imported.url && !imported.url.includes('/node_modules/') && !seen.has(imported.url)) next.push(imported.url);
      }
    }));
    wave = next;
  }
}
