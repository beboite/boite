import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

// The fake client seeds a paused-in-place run on `t-trace` with `team=1`:
// scan done, review fanned out over three files with one done, fix and report waiting.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(`document.fonts.ready`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&team=1`, windowSize: { width: 1680, height: 1000 } });
  // Wide enough for the run's four columns side by side.
  await page.evaluate(`localStorage.setItem('boite:right-panel-width', '900')`);
  await page.reload();
  await page.waitFor(`document.querySelector('${id('thread-row')}[data-thread-id="t-trace"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the chat card opens the run as columns with an arrow per dependency', async () => {
  await page.click(`${id('thread-row')}[data-thread-id="t-trace"]`);
  await page.waitFor(`document.querySelector('${id('workflow-activity')}')`);
  expect(await page.text(id('workflow-activity'))).toContain('1/4 steps');
  await capture('workflow-card.png');
  await page.click(id('workflow-activity'));
  await page.waitFor(`document.querySelector('${id('workflow-graph')}')?.dataset.layout === 'columns'`);
  await page.waitFor(`document.querySelectorAll('${id('workflow-edge')}').length === 3`);
  expect(await page.evaluate(`[...document.querySelectorAll('${id('workflow-node')}')].map(node => node.dataset.status)`)).toEqual(['done', 'running', 'waiting', 'waiting']);
  await capture('workflow-columns.png');
  await page.evaluate(`document.querySelectorAll('${id('workflow-node')}')[1].click()`);
  await page.waitFor(`document.querySelectorAll('${id('workflow-instance')}').length === 3`);
  await page.waitFor(`document.querySelector('${id('workflow-output')}') || document.querySelector('.transcript')`);
  await capture('workflow-step.png');
  await page.click(id('workflow-back'));
  expect(page.errors()).toEqual([]);
}, 40_000);

test('on a phone the same run reads as phases, top to bottom', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.waitFor(`document.querySelector('${id('workflow-graph')}')?.dataset.layout === 'phases'`);
  expect(await page.evaluate(`document.querySelectorAll('${id('workflow-column')}').length`)).toBe(4);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
  await capture('workflow-phone.png');
  expect(page.errors()).toEqual([]);
}, 30_000);
