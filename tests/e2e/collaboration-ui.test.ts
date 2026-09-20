import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let uiUrl: string;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])`);
}

beforeAll(async () => {
  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('[data-testid="coordination-panel"]')`);
  await page.evaluate(`(async () => {
    const { workspace } = await import('/src/lib/workspace.svelte.ts');
    const client = workspace.active.client;
    await workspace.active.open('t-trace');
    const team = { mode: 'team', resources: 'Owns provider descriptors and UI review', remote: true, paused: false };
    const brief = { mode: 'brief', resources: 'Owns trace contracts', remote: false, paused: false };
    await client.call('collaboration.configure', { threadId: 't-trace', config: team });
    await client.call('collaboration.configure', { threadId: 't-bench', config: brief });
    const identity = await client.call('collaboration.identity', {});
    await client.call('collaboration.send', {
      threadId: 't-trace',
      to: { coreId: identity.coreId, threadId: 't-bench' },
      text: 'Please confirm whether trace.get already carries peak memory.',
      requestId: 'letter-capture'
    });
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="coordination-panel"] [data-mode="team"]')`);
  await page.click('[data-testid="coordination-panel"] > summary');
  await page.waitFor(`document.querySelector('[data-testid="coordination-letter"]')`);
  await page.click('[data-testid="coordination-refresh"]');
  await page.waitFor(`document.querySelector('[data-testid="coordination-contact"]')`);
}, 30_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('coordination is separate from the user composer at desktop and phone widths', async () => {
  await settled();
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-budget"]').textContent`)).toContain('40 sends');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="coordination-contact"]').length`)).toBeGreaterThan(0);
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-letter"] summary').textContent`)).toContain('This PC');
  expect(await page.evaluate(`document.querySelector('[data-testid="composer"]')?.textContent ?? ''`)).not.toContain('Agent exchange');
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-desktop.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="coordination-panel"]').scrollIntoView({ block: 'start' })`);
  await settled();
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-phone.png'));
  await page.click('[data-testid="coordination-letter"] > summary');
  await page.evaluate(`document.querySelector('[data-testid="coordination-letter"]').scrollIntoView({ block: 'center' })`);
  await settled();
  expect(await page.evaluate(`document.querySelector('[data-testid="coordination-letter"]').textContent`)).toContain('Please confirm');
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-phone-exchange.png'));

  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent&machines=1`);
  await page.waitFor(`document.querySelector('[data-testid="nav-settings"]')`);
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-machines"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-link-pair"]')`);
  await page.click('[data-testid="agent-link"]');
  await page.waitFor(`document.querySelectorAll('[data-testid="agent-peer"]').length === 2`);
  await page.evaluate(`document.querySelector('[data-testid="agent-links"]').scrollIntoView({ block: 'center' })`);
  await settled();
  await page.screenshot(join(import.meta.dir, '.artifacts', 'coordination-machine-links.png'));
}, 30_000);
