import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the test UI servers share with the process that runs them, Bun or Node
 * (`ui-server.ts`): no Bun API and only erasable TypeScript, so Node runs it
 * by stripping the types.
 */
export const uiRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/ui');

// Expose fixture controls in both Vite modes without putting test hooks in the shipped UI.
export const fixtureBridge = {
  name: 'boite-e2e-fixture-controls',
  transform(code: string, id: string) {
    if (id.replaceAll('\\', '/') !== join(uiRoot, 'src/main.ts').replaceAll('\\', '/')) return;
    return `${code}\nimport { workspace } from './lib/workspace.svelte.ts';\nimport { setTheme } from './lib/theme.ts';\nimport { appUpdater } from './lib/app-update.svelte.ts';\nglobalThis.__boiteTest = { workspace, setTheme, appUpdater };\n`;
  },
};

interface DevServer {
  transformRequest(url: string): Promise<unknown>;
  environments: { client: { moduleGraph: { getModuleByUrl(url: string): Promise<{ importedModules: Set<{ url: string }> } | undefined> } } };
}

/**
 * Walks the imports from `entry`, lazy ones included, and returns how many it
 * transformed: 231 modules in 1.3 s on a warm workstation (2026-09-24), 823 in
 * 4.4 to 6.7 s on the Windows runner (2026-10-15). Vite 8 leaves
 * `TransformResult.deps` empty, so the edges come from the module graph.
 * Optimized dependencies are already on disk.
 */
export async function transformAll(server: DevServer, entry: string): Promise<number> {
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
  return seen.size;
}
