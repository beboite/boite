import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(import.meta.dir, '..', '..', '..', 'packages', 'ui');
export const UI_DIST = join(UI, 'dist');
const UI_INDEX = join(UI_DIST, 'index.html');
/** What the build reads: a change to any of these makes a `dist` stale. */
const UI_INPUTS = ['src', 'public', 'index.html', 'vite.config.ts', 'svelte.config.js', 'package.json'].map((name) => join(UI, name));

/**
 * What only a development bundle carries: an import of the fake client, which
 * `?fake=1` loads under `import.meta.env.DEV` alone, and Svelte's dev runtime
 * metadata. A child of `bun test` inherits `NODE_ENV=test`, and Vite then
 * builds in development mode while still printing "building for production".
 * The production build emits a `fake-client-*.js` chunk nothing imports, so a
 * file name alone proves nothing.
 */
export function developmentMarkers(files: { name: string; text: string }[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (file.text.includes('fake-client')) found.push(`${file.name}: imports fake-client`);
    if (file.text.includes('__svelte_meta')) found.push(`${file.name}: __svelte_meta`);
  }
  return found;
}

function newestInput(): number {
  let newest = 0;
  const walk = (path: string): void => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (!stat.isDirectory()) {
      // UI tests sit beside the components but never reach the bundle.
      if (!/\.test\.ts$/.test(path)) newest = Math.max(newest, stat.mtimeMs);
      return;
    }
    for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  for (const input of UI_INPUTS) walk(input);
  return newest;
}

function builtScripts(): { name: string; text: string }[] {
  const assets = join(UI_DIST, 'assets');
  if (!existsSync(assets)) return [];
  return readdirSync(assets).filter((name) => name.endsWith('.js')).map((name) => ({ name, text: readFileSync(join(assets, name), 'utf8') }));
}

/**
 * The production UI a real core serves, the one the user gets. Built again
 * only when `dist` is missing, older than its sources or a development build
 * an earlier run left, and always with `NODE_ENV=production`. CI builds it
 * once and sets `BOITE_E2E_PREBUILT_UI=1`.
 */
export function ensureProductionUi(): void {
  if (process.env.BOITE_E2E_PREBUILT_UI !== '1') {
    const fresh = existsSync(UI_INDEX) && statSync(UI_INDEX).mtimeMs >= newestInput() && developmentMarkers(builtScripts()).length === 0;
    if (!fresh) {
      const built = Bun.spawnSync({
        cmd: ['bun', 'run', '--cwd', UI, 'build'],
        env: { ...process.env, NODE_ENV: 'production' },
        stdout: 'pipe',
        stderr: 'pipe',
        windowsHide: true,
      });
      if (!built.success) throw new Error(`the ui did not build:\n${built.stderr.toString()}`);
    }
  }
  if (!existsSync(UI_INDEX)) throw new Error(`Missing prebuilt UI: ${UI_INDEX}. Run bun run build:ui first.`);
  const markers = developmentMarkers(builtScripts());
  if (markers.length > 0) throw new Error(`${UI_DIST} is a development build (${markers.join(', ')}); run bun run build:ui`);
}
