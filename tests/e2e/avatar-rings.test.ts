import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';

const root = join(import.meta.dir, '../../packages/ui');
const requireUi = createRequire(join(root, 'package.json'));
const cacheDir = join(import.meta.dir, '.artifacts', `avatar-rings-cache-${process.pid}`);
const { createServer } = await import(requireUi.resolve('vite'));
interface FixtureServer {
  listen(): Promise<unknown>;
  close(): Promise<void>;
  transformIndexHtml(url: string, html: string): Promise<string>;
  middlewares: { use(path: string, handler: (req: IncomingMessage, res: ServerResponse, next: (error?: unknown) => void) => void): void };
}
let server: FixtureServer;
let page: BrowserPage;

beforeAll(async () => {
  const port = await freePort();
  // Compile only the real avatar and row components, without warming the whole app.
  server = await createServer({ root, cacheDir, server: { host: '127.0.0.1', port, strictPort: true },
    optimizeDeps: { noDiscovery: true, entries: [] },
    plugins: [{ name: 'avatar-ring-fixture', configureServer(vite: FixtureServer) {
      vite.middlewares.use('/avatar-rings.html', async (_req, res, next) => {
        try {
          const html = await vite.transformIndexHtml('/avatar-rings.html', `<!doctype html><html lang="en" data-theme="dark" data-motion="reduced"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="fixture"></main><script type="module">
            import { mount } from 'svelte';
            import { startLocale } from '/src/lib/i18n.svelte.ts';
            import Fixture from '/@fs/${join(import.meta.dir, 'fixtures/AvatarRings.svelte').replaceAll('\\', '/')}';
            await startLocale();
            mount(Fixture, { target: document.querySelector('#fixture') });
          </script></body></html>`);
          res.setHeader('Content-Type', 'text/html'); res.end(html);
        } catch (error) { next(error); }
      });
    } }], clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/avatar-rings.html`, windowSize: { width: 1280, height: 900 } });
  await page.waitFor(`document.querySelectorAll('.agent-avatar svg.robot').length === 4`, 30_000);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); rmSync(cacheDir, { recursive: true, force: true }); }, 30_000);

for (const width of [1280, 390]) test(`avatar rings stay concentric and keep their fractional stroke at ${width}px`, async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
  await page.evaluate(`document.documentElement.style.zoom = 1`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `avatar-rings-${width}.png`));
  for (const zoom of [1, 1.1, 1.25]) {
    await page.evaluate(`document.documentElement.style.zoom = ${zoom}`);
    const rings = await page.evaluate<{ x: number; y: number; stroke: number }[]>(`[...document.querySelectorAll('.agent-avatar')].map(avatar => {
      const portrait = (avatar.querySelector('svg.robot') ?? avatar).getBoundingClientRect();
      const circle = avatar.querySelector('.avatar-ring circle');
      if (circle) {
        const box = circle.getBoundingClientRect();
        return { x: box.left + box.width / 2 - portrait.left - portrait.width / 2,
          y: box.top + box.height / 2 - portrait.top - portrait.height / 2,
          stroke: parseFloat(getComputedStyle(circle).strokeWidth) };
      }
      const ring = getComputedStyle(avatar, '::before');
      const box = avatar.getBoundingClientRect();
      const border = parseFloat(ring.borderLeftWidth);
      const padding = ring.boxSizing === 'border-box' ? 0 : border * 2;
      return { x: box.left + (parseFloat(ring.left) + (parseFloat(ring.width) + padding) / 2) * ${zoom} - portrait.left - portrait.width / 2,
        y: box.top + (parseFloat(ring.top) + (parseFloat(ring.height) + padding) / 2) * ${zoom} - portrait.top - portrait.height / 2,
        stroke: border };
    })`);
    expect(rings).toHaveLength(5);
    for (const ring of rings) {
      expect(Math.abs(ring.x), `${zoom}x horizontal offset`).toBeLessThan(0.02);
      expect(Math.abs(ring.y), `${zoom}x vertical offset`).toBeLessThan(0.02);
      expect(ring.stroke, `${zoom}x ring stroke must not snap to a whole pixel`).toBeCloseTo(1.5, 2);
    }
  }
  await page.evaluate(`document.documentElement.style.zoom = 1`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `avatar-rings-${width}.png`));
}, 30_000);
