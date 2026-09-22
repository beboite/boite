import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;

/**
 * Every icon a button draws, shown smaller than the size it was drawn at. The
 * padding of `button.small` once won over `button.icon`'s and left a 26 px
 * icon button 8 px for its glyph: the panel's maximize and close came out at
 * 6 px and every row menu at 8, which no unit test can see without a layout.
 */
const SQUEEZED = `(() => Array.from(document.querySelectorAll('button svg[width]')).flatMap((svg) => {
  const box = svg.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return [];
  const drawn = Number(svg.getAttribute('width'));
  if (!(drawn > 0) || box.width >= drawn - 0.5) return [];
  const button = svg.closest('button');
  const name = button.dataset.testid || button.getAttribute('aria-label') || button.className;
  return [name + ': drawn at ' + drawn + ' px, shown at ' + box.width.toFixed(1) + ' px'];
}))()`;

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}

async function squeezed(where: string): Promise<string[]> {
  await settled();
  return (await page.evaluate<string[]>(SQUEEZED)).map((line) => `${where}: ${line}`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, windowSize: { width: 1310, height: 820 } });
  // The app opens on a draft, so a thread is opened here for the icons a timeline draws.
  await page.click(id('thread-row'));
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('no button shows its icon smaller than it was drawn', async () => {
  const found: string[] = [];
  found.push(...await squeezed('chat'));

  // Every surface of the right panel, one at a time, back to the launcher in between.
  await page.click(id('panel-toggle'));
  await page.waitFor(`document.querySelector('${id('panel-launcher')}')`);
  for (const kind of ['trace', 'changes', 'files', 'tasks']) {
    if (await page.evaluate<boolean>(`document.querySelector('${id(`launch-${kind}`)}').disabled`)) continue;
    await page.click(id(`launch-${kind}`));
    await page.waitFor(`document.querySelector('${id('panel-tab')}[data-kind="${kind}"]')`);
    found.push(...await squeezed(`panel ${kind}`));
    await page.click(id('panel-tab-close'));
    await page.waitFor(`document.querySelector('${id('panel-launcher')}')`);
  }

  await page.click(id('nav-settings'));
  await page.waitFor(`document.querySelector('${id('settings')}')`);
  const tabs = await page.evaluate<string[]>(`Array.from(document.querySelectorAll('[data-testid^="settings-tab-"]')).map(tab => tab.dataset.testid)`);
  expect(tabs.length).toBeGreaterThan(3);
  for (const tab of tabs) {
    await page.click(id(tab));
    await page.waitFor(`document.querySelector('${id(tab)}').getAttribute('aria-current') === 'page'`);
    found.push(...await squeezed(tab));
  }

  expect(found).toEqual([]);
}, 60_000);
