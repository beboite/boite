import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let server: Awaited<ReturnType<typeof startUi>>;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const onStore = (code: string) => page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({store}) => { ${code} })`);

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port, { development: true });
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1310, height: 900 } });
  await page.waitFor(`document.querySelector('${id('thread-title')}')`);
}, 90_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

test('owner compares two isolated proposals with desktop and phone layouts', async () => {
  expect(await page.evaluate(`document.querySelector('${id('proposal-compare-open')}') === null`)).toBe(true);
  await page.evaluate(`import('/src/lib/experiments.ts').then(({setExperiment}) => setExperiment('proposal-comparison', true))`);
  await page.click(id('proposal-compare-open'));
  await page.waitFor(`document.querySelector('${id('proposal-comparison')}')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('proposal-column')}').length`)).toBe(2);
  expect(await page.evaluate(`document.querySelector('${id('proposal-launch')}').disabled`)).toBe(true);

  // The shared picker must anchor to its own control outside the composer.
  await page.click(`${id('proposal-column')}[data-proposal=b] ${id('composer-picker')}`);
  await page.waitFor(`document.querySelector('${id('proposal-comparison')} ${id('composer-picker-menu')}')`);
  expect(await page.evaluate(`(() => { const box = document.querySelector('${id('proposal-comparison')} ${id('composer-picker-menu')}').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight; })()`)).toBe(true);
  await page.evaluate(`document.querySelector('${id('proposal-comparison')} ${id('composer-picker-menu')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`!document.querySelector('${id('proposal-comparison')} ${id('composer-picker-menu')}')`);
  expect(await page.evaluate(`!!document.querySelector('${id('proposal-comparison')}')`)).toBe(true);

  await onStore(`window.__proposalCalls = []; const original = store.client.call.bind(store.client); store.client.call = (method, params) => { window.__proposalCalls.push({method, params}); return original(method, params); };`);
  await page.type(id('proposal-prompt'), 'Suggest a clearer empty state for the project list.');
  await capture('proposals-desktop-setup.png');
  await page.click(id('proposal-launch'));
  await page.waitFor(`document.querySelectorAll('${id('proposal-comparison')} .continue').length === 2`);
  await page.waitFor(`Array.from(document.querySelectorAll('${id('proposal-response')}')).every(node => node.querySelector('.prose'))`, 25_000);
  const calls = await page.evaluate<{ method: string; params: Record<string, unknown> }[]>('window.__proposalCalls');
  const creates = calls.filter(call => call.method === 'threads.create');
  const starts = calls.filter(call => call.method === 'turns.start');
  const secondId = await onStore(`return store.threads.find(thread => thread.title.startsWith('B: Suggest a clearer')).id;`);
  expect(creates).toHaveLength(2);
  expect(creates.every(call => call.params.worktree && call.params.permissionMode === 'default')).toBe(true);
  expect(starts).toHaveLength(2);
  expect(starts[0]!.params.prompt).toBe(starts[1]!.params.prompt);
  expect(starts[0]!.params.threadId).not.toBe(starts[1]!.params.threadId);
  expect(await page.evaluate(`(() => { const [a,b] = document.querySelectorAll('${id('proposal-column')}'); return Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) < 2; })()`)).toBe(true);
  await capture('proposals-desktop.png');
  for (const proposal of ['a', 'b']) {
    await page.click(`${id('proposal-column')}[data-proposal=${proposal}] summary`);
    await page.click(`${id('proposal-column')}[data-proposal=${proposal}] ${id('proposal-change')}`);
    await page.waitFor(`document.querySelector('${id('proposal-column')}[data-proposal=${proposal}] ${id('diff-view')}')`);
  }
  await page.evaluate(`document.querySelector('${id('proposal-column')}[data-proposal=a] ${id('diff-view')}').scrollIntoView({block:'center'})`);
  await capture('proposals-desktop-changes.png');

  await page.evaluate(`document.querySelectorAll('${id('proposal-changes')}').forEach(node => node.open = false); document.querySelector('${id('proposal-comparison')} .body').scrollTop = 0`);

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`(() => { const [a,b] = document.querySelectorAll('${id('proposal-column')}'); return b.getBoundingClientRect().top >= a.getBoundingClientRect().bottom; })()`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('${id('proposal-comparison')}').scrollWidth <= innerWidth`)).toBe(true);
  await capture('proposals-phone.png');
  await page.click(`${id('proposal-column')}[data-proposal=a] summary`);
  await page.evaluate(`document.querySelector('${id('proposal-column')}[data-proposal=a] ${id('diff-view')}').scrollIntoView({block:'center'})`);
  await capture('proposals-phone-changes.png');

  // Closing and reopening preserves the pair; it never sends another prompt.
  await page.evaluate(`document.querySelector('${id('proposal-comparison')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`!document.querySelector('${id('proposal-comparison')}')`);
  await page.click(id('proposal-compare-open'));
  await page.waitFor(`document.querySelectorAll('${id('proposal-comparison')} .continue').length === 2`);
  expect(await page.evaluate(`window.__proposalCalls.filter(call => call.method === 'turns.start').length`)).toBe(2);
  await page.click(`${id('proposal-column')}[data-proposal=b] .continue`);
  await page.waitFor(`!document.querySelector('${id('proposal-comparison')}')`);
  await page.waitFor(`import('/src/lib/store.svelte.ts').then(({store}) => store.openThread?.id === ${JSON.stringify(secondId)})`);
  expect(await onStore('return store.openThread?.id')).toBe(secondId);
  // A header unmount must preserve the pair for this Store and project.
  await page.evaluate(`import('/src/lib/experiments.ts').then(({setExperiment}) => setExperiment('proposal-comparison', false))`);
  await page.waitFor(`!document.querySelector('${id('proposal-compare-open')}')`);
  await page.evaluate(`import('/src/lib/experiments.ts').then(({setExperiment}) => setExperiment('proposal-comparison', true))`);
  await page.click(id('proposal-compare-open'));
  await page.waitFor(`document.querySelectorAll('${id('proposal-comparison')} .continue').length === 2`);
  expect(await page.evaluate(`window.__proposalCalls.filter(call => call.method === 'turns.start').length`)).toBe(2);
  await onStore(`store.principal = 'session';`);
  await page.waitFor(`!document.querySelector('${id('proposal-compare-open')}')`);
  expect(page.errors()).toEqual([]);
}, 60_000);
