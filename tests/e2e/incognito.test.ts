import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const present = (name: string) => `!!document.querySelector('${id(name)}')`;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1310, height: 820 } });
  await page.waitFor(`document.querySelector('${id('timeline')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the drafts header switches incognito on, and leaving the conversation erases it', async () => {
  await page.evaluate(`(async () => {
    const { setLocaleSetting } = await import('/src/lib/i18n.svelte.ts');
    await setLocaleSetting('fr');
    __boiteTest.workspace.active.startDraft(null);
  })()`);
  await page.waitFor(present('draft-incognito'));
  // A project of one's own offers no switch: only the drafts do.
  await page.evaluate(`__boiteTest.workspace.active.setDraftProject(__boiteTest.workspace.active.projects.find(p => p.kind !== 'drafts').id)`);
  await page.waitFor(`!${present('draft-incognito')}`);
  await page.evaluate(`__boiteTest.workspace.active.setDraftProject(null)`);
  await page.waitFor(present('draft-incognito'));
  expect(await page.evaluate(`document.querySelector('${id('draft-incognito')}').getAttribute('aria-pressed')`)).toBe('false');

  await page.click(id('draft-incognito'));
  await page.waitFor(`document.querySelector('${id('draft-incognito')}').getAttribute('aria-pressed') === 'true'`);
  await page.waitFor(present('draft-incognito-note'));
  // The switch sits at the right end of the bar, next to the window's own corner.
  const gap = await page.evaluate<number>(`innerWidth - document.querySelector('${id('draft-incognito')}').getBoundingClientRect().right`);
  expect(gap).toBeLessThan(24);
  await capture('incognito-draft.png');

  await page.type(id('composer-input'), 'Plan a surprise party');
  await page.click(id('composer-send'));
  await page.waitFor(present('thread-incognito'));
  const threadId = await page.evaluate<string>('__boiteTest.workspace.active.openThread.id');
  // The sidebar never lists it.
  expect(await page.evaluate<boolean>(`[...document.querySelectorAll('${id('thread-row')}')].some(row => row.textContent.includes('Plan a surprise party'))`)).toBe(false);
  await capture('incognito-thread.png');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('incognito-thread-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);

  await page.evaluate('__boiteTest.workspace.active.startDraft(null)');
  await page.waitFor(present('draft-incognito'));
  // The new draft starts as an ordinary one, and the conversation left is gone from the core.
  expect(await page.evaluate(`document.querySelector('${id('draft-incognito')}').getAttribute('aria-pressed')`)).toBe('false');
  await page.waitFor(`(async () => !(await __boiteTest.workspace.active.client.call('threads.list', {})).some(row => row.id === '${threadId}'))()`);
  await page.click(id('draft-incognito'));
  await capture('incognito-draft-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1310, height: 820, deviceScaleFactor: 1, mobile: false });
}, 60_000);
