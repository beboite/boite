import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1300, height: 850 } });
  await page.waitFor(`document.querySelector('[data-thread-id]')`);
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
}
/** The dialog inside the viewport and every tool row inside the dialog. */
const fits = `(() => {
  const box = document.querySelector('[data-testid="agent-shape"]').getBoundingClientRect();
  const rows = [...document.querySelectorAll('[data-testid="agent-shape-tool"]')].map(row => row.getBoundingClientRect());
  return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight
    && rows.length > 0 && rows.every(row => row.left >= box.left && row.right <= box.right + 0.5);
})()`;

test('a Claude thread shows what its last request carried, at desktop and phone widths', async () => {
  await page.evaluate(`(async () => {
    const { workspace } = await import('/src/lib/workspace.svelte.ts');
    const store = workspace.active;
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'claude', accountId: 'a-claude-main', model: 'claude-opus-5-5', effort: 'high' });
    await store.client.call('turns.start', { threadId: thread.id, prompt: 'Show me what you start with.' });
    await store.open(thread.id);
    window.__shapeThread = thread.id;
  })()`);
  await page.waitFor(`document.querySelector('[data-thread-id="' + window.__shapeThread + '"]')`);
  await page.waitFor(`(async () => { const { workspace } = await import('/src/lib/workspace.svelte.ts'); return workspace.active.openThread?.status === 'idle'; })()`);
  await page.evaluate(`document.querySelector('[data-testid="context-trigger"]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="context-agent-shape"]')`);
  await capture('agent-shape-entry');
  await page.evaluate(`document.querySelector('[data-testid="context-agent-shape"]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-shape-summary"]')`);
  await page.evaluate(`document.querySelector('[data-testid="agent-shape-block"]').open = true`);
  await capture('agent-shape-desktop');
  expect(await page.evaluate(fits)).toBe(true);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 330, height: 720, deviceScaleFactor: 2, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.waitFor(`document.querySelector('[data-testid="agent-shape"]').getBoundingClientRect().width <= 330`);
  await capture('agent-shape-phone');
  expect(await page.evaluate(fits)).toBe(true);
  await page.evaluate(`document.querySelector('[data-testid="agent-shape"] .body').scrollTop = 10000`);
  await capture('agent-shape-phone-tools');
  await page.evaluate(`document.querySelector('[data-testid="agent-shape-close"]').click()`);
  await page.waitFor(`!document.querySelector('[data-testid="agent-shape"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: false });
}, 60_000);
