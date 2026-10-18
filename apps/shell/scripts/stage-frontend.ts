/**
 * The UI the shell embeds: `packages/ui/dist` without the `.br` and `.gz`
 * copies Vite writes beside each asset. The core serves those to phones from
 * the `ui` directory installed beside the shell, which keeps the full dist
 * (`bundle.resources`); the window loads its UI from the executable and never
 * asks for them, so embedding them only made the executable 2 MB larger.
 *
 * `tauri.conf.json` runs this after the UI build (`beforeBuildCommand`) and
 * points `frontendDist` at its output, `apps/shell/dist`.
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const shell = resolve(import.meta.dir, '..');
const source = join(shell, '..', '..', 'packages', 'ui', 'dist');
const target = join(shell, 'dist');

if (!existsSync(join(source, 'index.html'))) {
  console.error(`stage-frontend: ${join(source, 'index.html')} does not exist. Build the UI first: bun run build:ui`);
  process.exit(1);
}
// Asset names carry a hash: what an earlier build left would only be embedded.
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true, filter: (path) => !/\.(?:br|gz)$/.test(path) });
console.log(`stage-frontend: ${target} (packages/ui/dist without .br and .gz)`);
