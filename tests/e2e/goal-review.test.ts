import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

// The Reviewed goals experiment on the fake core: the first review fails, the
// agent works on the finding, the second passes. Captures the bar mid-review
// and the Tasks panel once finished, at desktop and phone widths.
let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
const dots = `${id('activity-goal-reviews')} .verdict`;

async function size(phone: boolean) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone
  });
  await page.waitFor(`innerWidth === ${phone ? 390 : 1280} && innerHeight === ${phone ? 844 : 900}`);
}
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
}
const verdicts = () => page.evaluate<string[]>(`Array.from(document.querySelectorAll('${dots}')).map(dot => dot.dataset.verdict)`);

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('${id('composer-input')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test.each([['desktop', false], ['phone', true]] as const)('a reviewed goal shows its failed review, the next one running, then the pass (%s)', async (name, phone) => {
  await size(phone);
  await page.type(id('composer-input'), '/goal2 Rename the empty state label');
  await page.evaluate(`document.querySelector('${id('composer-input')}').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`);
  await page.waitFor(`document.querySelector('${id('activity-goal')}')?.textContent.includes('Reviewed goal')`);
  await page.waitFor(`document.querySelector('${dots}[data-verdict="fail"]') && document.querySelector('${dots}[data-verdict="running"]')`, 20_000);
  expect(await page.text(id('activity-goal'))).toContain('Reviewing');
  await capture(`goal2-reviewing-${name}`);
  await page.waitFor(`document.querySelector('${dots}[data-verdict="pass"]')`, 20_000);
  expect(await verdicts()).toEqual(['fail', 'pass']);
  // The owner's app keeps one line in the bar; the checklist and each review's findings are in the side panel's Tasks tab.
  await page.click(id('activity-tasks-toggle'));
  await page.waitFor(`document.querySelector('${id('tasks-reviews')}')?.textContent.includes('The empty state still shows the old label') && document.querySelector('${id('tasks-checklist')}')`);
  expect(await page.text(id('tasks-checklist-progress'))).toContain('1/1 done');
  await capture(`goal2-passed-${name}`);
  await page.click(id('panel-close'));
  await page.waitFor(`!document.querySelector('${id('tasks-reviews')}')`);
  // A dot opens that review's own conversation, a child the header leads back from.
  await page.click(`${dots}[data-verdict="fail"]`);
  await page.waitFor(`document.querySelector('${id('delegation-back-parent')}')`);
  expect(await page.text('body')).toContain('VERDICT: FAIL');
  await capture(`goal2-reviewer-${name}`);
  await page.click(id('delegation-back-parent'));
  await page.waitFor(`document.querySelector('${id('activity-goal')}')`);
  expect(page.errors()).toEqual([]);
}, 60_000);
