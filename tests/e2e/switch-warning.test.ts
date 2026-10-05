import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port = 0;
const pages: BrowserPage[] = [];

beforeAll(async () => {
  port = await freePort();
  server = await startUi(port);
}, 90_000);
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
}, 15_000);
afterAll(async () => {
  await server?.close();
}, 15_000);

const STORE = `globalThis.__boiteTest.workspace.active`;

/** Opens the recent thread with a long context and picks a Claude model, the seeded thread being echo's. */
async function switchAway(size: { width: number; height: number }, name: string): Promise<BrowserPage> {
  const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: size });
  pages.push(page);
  await page.waitFor(`document.querySelector('[data-testid="composer-picker"]')`);
  await page.evaluate(`(async () => { const store = ${STORE}; store.openThread.context = { tokens: 240000, window: 1000000, at: Date.now() }; window.__account = store.openThread.accountId; window.__provider = store.openThread.providerId; })()`);
  await page.click('[data-testid="composer-picker"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"] [data-provider]')`);
  await page.click('[data-testid="composer-picker-menu"] [data-provider="claude"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"] [data-model]')`);
  await page.evaluate(`document.querySelector('[data-testid="composer-picker-menu"] [data-model]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
  return page;
}

const account = (page: BrowserPage) => page.evaluate<boolean>(`(async () => (${STORE}).openThread.accountId === window.__account)()`);

test('a long thread asks before it moves to another account, and Cancel leaves it where it was', async () => {
  const page = await switchAway({ width: 1300, height: 850 }, 'switch-warning-desktop');
  expect(await page.text('[data-testid="confirm-dialog"]')).toContain('240');
  await page.click('[data-testid="confirm-cancel"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  expect(await account(page)).toBe(true);
}, 90_000);

test('the same question on a phone, and Switch moves the thread', async () => {
  const page = await switchAway({ width: 390, height: 844 }, 'switch-warning-phone');
  await page.click('[data-testid="confirm-ok"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.waitFor(`(async () => (${STORE}).openThread.accountId !== window.__account)()`);
  expect(await account(page)).toBe(false);
}, 90_000);

/** Opens the same long thread and moves its reasoning effort to the lowest level, inside the account. */
async function lowerEffort(size: { width: number; height: number }, name: string, locale?: string): Promise<BrowserPage> {
  const url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  const page = await BrowserPage.launch({ url, windowSize: size });
  pages.push(page);
  await page.waitFor(`document.querySelector('[data-testid="composer-effort"]')`);
  if (locale) {
    await page.evaluate(`localStorage.setItem('boite.locale', ${JSON.stringify(locale)})`);
    await page.navigate(url);
    await page.waitFor(`document.querySelector('[data-testid="composer-effort"]')`);
  }
  await page.evaluate(`(async () => { const store = ${STORE}; store.openThread.context = { tokens: 150000, window: 1000000, at: Date.now() }; window.__effort = store.openThread.effort; })()`);
  await page.click('[data-testid="composer-effort"]');
  await page.waitFor(`document.querySelector('[data-testid=effort-track]')`);
  await page.evaluate(`document.querySelector('[data-testid=effort-track]').dispatchEvent(new KeyboardEvent('keydown', { key:'Home', bubbles:true }))`);
  await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
  return page;
}

const effort = (page: BrowserPage) => page.evaluate<boolean>(`(async () => (${STORE}).openThread.effort === window.__effort)()`);

test('native speed switches keep Codex unblocked and warn only when enabling Claude Fast, on desktop and phone', async () => {
  const url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  const page = await BrowserPage.launch({ url });
  pages.push(page);
  for (const [width, height, name] of [[1300, 850, 'desktop'], [390, 844, 'phone']] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: name === 'phone' });
    await page.navigate(url);
    await page.waitFor(`document.querySelector('[data-testid="composer-picker"]')`);
    for (const [provider, model, speeds] of [['codex', 'codex-demo', ['fast', 'ultrafast', null]], ['claude', 'claude-opus-5-5', ['fast', null]]] as const) {
      await page.evaluate(`(async () => { const store = ${STORE}; store.openThread.context = { tokens: 0, window: 1000000, at: Date.now() }; document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); })()`);
      await page.click('[data-testid="composer-picker"]');
      await page.click(`[data-provider="${provider}"]`);
      await page.waitFor(`document.querySelector('[data-model="${model}"]')`);
      await page.click(`[data-model="${model}"]`);
      await page.waitFor(`(async () => (${STORE}).openThread.model === ${JSON.stringify(model)})()`);
      await page.evaluate(`(async () => { (${STORE}).openThread.context = { tokens: 150000, window: 1000000, at: Date.now() }; })()`);
      if (name === 'phone') {
        await page.click('[data-testid="composer-options"]');
        await page.waitFor(`document.querySelector('[data-testid="composer-options-sheet"] input[name="mobile-speed"]')`);
      }
      for (const speed of speeds) {
        if (name === 'phone') {
          const position = speed === null ? 1 : speed === 'fast' ? 2 : 3;
          await page.click(`[data-testid="composer-options-sheet"] label:nth-child(${position}) input[name="mobile-speed"]`);
        } else {
          if (!await page.evaluate(`!!document.querySelector('[data-testid="effort-speed"]')`)) {
            await page.click('[data-testid="composer-effort"]');
            await page.waitFor(`document.querySelector('[data-testid="effort-speed"]')`);
          }
          await page.click('[data-testid="effort-speed"]');
        }
        if (provider === 'claude' && speed === 'fast') {
          await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
          expect(await page.text('[data-testid="confirm-dialog"]')).toContain('enabling Claude Fast mode for the first time');
          await page.click('[data-testid="confirm-ok"]');
          await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
        }
        await page.waitFor(`(async () => (${STORE}).openThread.speed === ${JSON.stringify(speed)})()`);
        expect(await page.evaluate(`!!document.querySelector('[data-testid="confirm-dialog"]')`)).toBe(false);
        if (name === 'phone') await page.waitFor(`!document.querySelector('[data-testid="composer-options-sheet"] input[name="mobile-speed"]').matches(':disabled')`);
        if (speed === 'fast') {
          await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
          await page.screenshot(join(import.meta.dir, '.artifacts', `speed-cache-${provider}-${name}.png`));
        }
      }
      if (name === 'phone') {
        await page.click('[data-testid="composer-options-sheet"] header button');
        await page.waitFor(`!document.querySelector('[data-testid="composer-options-sheet"]')`);
      }
    }
  }
}, 120_000);

test('an effort change on a long warm thread asks first, and Cancel keeps the effort', async () => {
  const page = await lowerEffort({ width: 1300, height: 850 }, 'cache-warning-desktop');
  expect(await page.text('[data-testid="confirm-dialog"]')).toContain('150');
  await page.click('[data-testid="confirm-cancel"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  expect(await effort(page)).toBe(true);
}, 90_000);

test('the cache question on a phone, and Change applies the effort', async () => {
  const page = await lowerEffort({ width: 390, height: 844 }, 'cache-warning-phone');
  await page.click('[data-testid="confirm-ok"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.waitFor(`(async () => (${STORE}).openThread.effort !== window.__effort)()`);
  expect(await effort(page)).toBe(false);
}, 90_000);

test('the French question fits on desktop and phone', async () => {
  for (const [size, name] of [[{ width: 1300, height: 850 }, 'cache-warning-desktop-fr'], [{ width: 390, height: 844 }, 'cache-warning-phone-fr']] as const) {
    const page = await lowerEffort(size, name, 'fr');
    expect(await page.text('[data-testid="confirm-dialog"]')).toContain('Reconstruire le cache');
    const fits = await page.evaluate<boolean>(`(() => { const r = document.querySelector('[data-testid="confirm-dialog"]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`);
    expect(fits).toBe(true);
  }
}, 120_000);
