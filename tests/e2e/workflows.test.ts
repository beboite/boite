import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

// The fake client seeds a paused-in-place run on `t-trace` with `team=1`:
// scan done, review fanned out over three files with one done, fix and tests
// side by side after it, report waiting on both.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.evaluate(`document.fonts.ready`);
  // The panel fades in: wait for the finite animations, not the live dots that pulse forever.
  await page.waitFor(`document.getAnimations().every(a => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity)`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&team=1`, windowSize: { width: 1680, height: 1000 } });
  await page.waitFor(`document.querySelector('${id('thread-row')}[data-thread-id="t-trace"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the chat card opens the run top to bottom, an arrow per dependency, in the panel at its default width', async () => {
  await page.click(`${id('thread-row')}[data-thread-id="t-trace"]`);
  await page.waitFor(`document.querySelector('${id('workflow-activity')}')`);
  expect(await page.text(id('workflow-activity'))).toContain('1/5 steps');
  await capture('workflow-card.png');
  await page.click(id('workflow-activity'));
  await page.waitFor(`document.querySelector('${id('workflow-graph')}')?.dataset.layout === 'rows'`);
  await page.waitFor(`document.querySelectorAll('${id('workflow-edge')}').length === 5`);
  expect(await page.evaluate(`[...document.querySelectorAll('${id('workflow-node')}')].map(node => node.dataset.status)`)).toEqual(['done', 'running', 'waiting', 'waiting', 'waiting']);
  // Each phase sits under the one before it.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('workflow-phase')}')].every((phase, i, all) => i === 0 || phase.getBoundingClientRect().top >= all[i - 1].getBoundingClientRect().bottom)`)).toBe(true);
  await capture('workflow-rows.png');
  await page.evaluate(`localStorage.setItem('boite:right-panel-width', '900')`);
  await page.reload();
  await page.waitFor(`document.querySelector('${id('thread-row')}[data-thread-id="t-trace"]')`);
  await page.click(`${id('thread-row')}[data-thread-id="t-trace"]`);
  await page.waitFor(`document.querySelector('${id('workflow-activity')}')`);
  await page.click(id('workflow-activity'));
  await page.waitFor(`document.querySelectorAll('${id('workflow-edge')}').length === 5`);
  await capture('workflow-rows-wide.png');
  await page.evaluate(`document.querySelectorAll('${id('workflow-node')}')[1].click()`);
  await page.waitFor(`document.querySelectorAll('${id('workflow-instance')}').length === 3`);
  await page.waitFor(`document.querySelector('${id('workflow-output')}') || document.querySelector('.transcript')`);
  await capture('workflow-step.png');
  await page.click(id('workflow-back'));
  expect(page.errors()).toEqual([]);
}, 40_000);

test('on a phone the same run keeps its rows and arrows without scrolling sideways', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.waitFor(`document.querySelector('${id('workflow-graph')}')?.dataset.layout === 'rows'`);
  await page.waitFor(`document.querySelectorAll('${id('workflow-edge')}').length === 5`);
  expect(await page.evaluate(`document.querySelectorAll('${id('workflow-phase')}').length`)).toBe(4);
  // The arrows once drawn for the wide panel must not hold the graph at that width.
  expect(await page.evaluate(`(g => g.scrollWidth <= g.clientWidth)(document.querySelector('${id('workflow-graph')}'))`)).toBe(true);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`)).toBe(true);
  await capture('workflow-phone.png');
  expect(page.errors()).toEqual([]);
}, 30_000);
