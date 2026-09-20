import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';

const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
let origin = '';

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
async function viewport(width: number, height: number, mobile = false) {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
}
async function scheme(value: 'dark' | 'light') {
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
}
async function mouse(x: number, y: number) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
}
async function box(selector: string) {
  return page.evaluate<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>(
    `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`
  );
}
const attribute = (selector: string, name: string) => page.evaluate<string | null>(`document.querySelector(${JSON.stringify(selector)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const count = (selector: string) => page.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
const fits = () => page.evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-testid=usage-page] .card')].every(card => card.getBoundingClientRect().right <= innerWidth + 0.5)`);

async function openUsage() {
  await page.click('[data-testid=nav-settings]');
  await page.click('[data-testid=settings-tab-usage]');
  await page.waitFor(`document.querySelector('[data-testid=usage-chart] svg path')`);
}

async function openLimits() {
  // Settings may already be open from the previous test, and its entry then lives in the nav.
  if (await page.evaluate<boolean>(`!document.querySelector('[data-testid=settings-tab-limits]')`)) {
    await page.click('[data-testid=nav-settings]');
  }
  await page.click('[data-testid=settings-tab-limits]');
  await page.waitFor(`document.querySelector('[data-testid=limits-page]')`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  origin = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${origin}/?fake=1`, windowSize: { width: 1280, height: 800 } });
  await scheme('dark');
  await viewport(1280, 800);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('the desktop page charts each day by provider, reads a column on hover and keys, and lists models and threads', async () => {
  await openUsage();
  expect(await attribute('[data-testid=usage-chart]', 'aria-valuemax')).toBe('29');
  expect(await count('[data-testid=usage-providers] li')).toBe(6);
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=usage-providers] li')].map(li => li.dataset.provider)`)).toEqual(['claude', 'codex', 'opencode', 'grok', 'antigravity', 'pi']);
  expect(await count('[data-testid=usage-threads] li')).toBe(10);
  await capture('usage-desktop-dark.png');

  const chart = await box('[data-testid=usage-chart]');
  await mouse(chart.right - 12, chart.top + chart.height / 2);
  await page.waitFor(`document.querySelector('[data-testid=usage-tooltip]')`);
  const tooltip = await page.text('[data-testid=usage-tooltip]');
  expect(tooltip).toContain('Total');
  expect(tooltip).toContain('Claude');
  const tip = await box('[data-testid=usage-tooltip]');
  expect(tip.left).toBeGreaterThanOrEqual(chart.left);
  expect(tip.right).toBeLessThanOrEqual(chart.right + 0.5);
  await capture('usage-desktop-tooltip.png');
  await mouse(4, 4);
  await page.waitFor(`!document.querySelector('[data-testid=usage-tooltip]')`);

  await page.evaluate(`document.querySelector('[data-testid=usage-chart]').focus()`);
  expect(await attribute('[data-testid=usage-chart]', 'aria-valuenow')).toBe('29');
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await page.waitFor(`document.querySelector('[data-testid=usage-chart]').getAttribute('aria-valuenow') === '28'`);
  expect(await attribute('[data-testid=usage-chart]', 'aria-valuetext')).toContain('Total');
  await page.evaluate(`document.activeElement.blur()`);

  await page.click('[data-testid=usage-metric-cost]');
  await page.waitFor(`document.querySelector('[data-testid=usage-unpriced]')`);
  expect(await page.text('[data-testid=usage-unpriced]')).toContain('Codex');
  expect(await page.text('[data-testid=usage-total]')).toMatch(/^\$/);
  await capture('usage-desktop-cost.png');

  await page.click('[data-testid=usage-metric-tokens]');
  await page.click('[data-testid=usage-range-7]');
  await page.waitFor(`document.querySelector('[data-testid=usage-chart]')?.getAttribute('aria-valuemax') === '6'`);
  await page.click('[data-testid=usage-range-90]');
  await page.waitFor(`document.querySelector('[data-testid=usage-chart]')?.getAttribute('aria-valuemax') === '89'`);
  await page.click('[data-testid=usage-by-day]');
  await page.waitFor(`document.querySelectorAll('[data-testid=usage-breakdown] tbody tr').length > 30`);
  await page.click('[data-testid=usage-by-model]');
  await capture('usage-desktop-90-days.png');

  await viewport(1280, 2300);
  await capture('usage-desktop-full-dark.png');
  await scheme('light');
  await capture('usage-desktop-full-light.png');
  expect(await fits()).toBe(true);
  await scheme('dark');
  await viewport(1280, 800);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('the phone page fits 390 px and is reachable from the phone settings list', async () => {
  await viewport(390, 844, true);
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail] [data-testid=usage-chart] svg path')`);
  expect(await fits()).toBe(true);
  await capture('usage-phone-dark.png');

  await page.evaluate(`document.querySelector('[data-testid=usage-chart]').scrollIntoView({ block: 'center' })`);
  const chart = await box('[data-testid=usage-chart]');
  await mouse(chart.left + chart.width / 2, chart.top + chart.height / 2);
  await page.waitFor(`document.querySelector('[data-testid=usage-tooltip]')`);
  const tip = await box('[data-testid=usage-tooltip]');
  expect(tip.left).toBeGreaterThanOrEqual(0);
  expect(tip.right).toBeLessThanOrEqual(390);
  await capture('usage-phone-tooltip.png');
  await mouse(2, 2);

  await viewport(390, 3000, true);
  await capture('usage-phone-full-dark.png');
  await scheme('light');
  expect(await fits()).toBe(true);
  await capture('usage-phone-full-light.png');
  await scheme('dark');
  await viewport(390, 844, true);

  await page.click('[data-testid=mobile-settings-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home] [data-testid=settings-tab-usage]')`);
  await capture('usage-phone-settings-home.png');
  await page.click('[data-testid=settings-tab-usage]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail] [data-testid=usage-page]')`);
  expect(page.errors()).toEqual([]);
  // Leave the detail page the way a phone does, so its history entry is gone before the next navigation.
  await page.click('[data-testid=mobile-settings-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
}, 60_000);

test('the limits tab is its own page, one card per provider, no scrolling through the history', async () => {
  await viewport(1280, 800);
  await openLimits();
  await page.waitFor(`document.querySelectorAll('[data-testid=usage-limit-account]').length >= 3`);
  // The limits answer the first screen: nothing of the history is loaded beside them.
  expect(await count('[data-testid=usage-chart]')).toBe(0);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('limits-desktop-dark.png');
  await scheme('light');
  await capture('limits-desktop-light.png');
  await scheme('dark');

  await viewport(390, 844, true);
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail] [data-testid=limits-page]')`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('limits-phone-dark.png');
  await page.click('[data-testid=mobile-settings-back]');
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  await viewport(1280, 800);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('a paired device reads the history and is told where the limits are', async () => {
  await viewport(1280, 800);
  await page.navigate(`${origin}/?fake=1&principal=session`);
  await openLimits();
  await page.waitFor(`document.querySelector('[data-testid=usage-limits-owner]')`);
  expect(await count('[data-testid=usage-limit-account]')).toBe(0);
  await capture('usage-device.png');
  expect(page.errors()).toEqual([]);
}, 60_000);
