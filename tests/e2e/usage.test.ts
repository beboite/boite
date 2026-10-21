import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let origin = '';

/** `history.back()` the way a loaded runner lands it: once the next navigation has started, or after 250 ms. */
const SLOW_BACK = `{
  const back = History.prototype.back;
  History.prototype.back = function () {
    let landed = false;
    const land = () => { if (!landed) { landed = true; back.call(history); } };
    addEventListener('beforeunload', () => setTimeout(land, 0), { once: true });
    setTimeout(land, 250);
  };
}`;

/**
 * A transition caught by a `content-visibility: hidden` lock the way a loaded runner caught one after a theme
 * switch: Chrome stops updating it, so its `finished` promise never settles and the hang probe lists nothing.
 * Planted in every page here, it hangs any capture that awaits every animation instead of the drawn ones.
 */
const STUCK_TRANSITION = `addEventListener('DOMContentLoaded', () => {
  const lock = document.body.appendChild(document.createElement('div'));
  lock.style.cssText = 'position: fixed; width: 0; height: 0; overflow: hidden';
  const text = lock.appendChild(document.createElement('span'));
  text.style.transition = 'color 10s';
  getComputedStyle(text).color;
  text.style.color = 'red';
  getComputedStyle(text).color;
  // Locked once the transition has run a frame: one locked before its first update is dropped.
  requestAnimationFrame(() => requestAnimationFrame(() => { lock.style.contentVisibility = 'hidden'; }));
});`;

async function capture(name: string) {
  await page.settleAnimations();
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
  // Settings may already be open from the previous test, and its entry then lives in the nav. Back from a
  // phone width, the desktop's settings nav draws a frame after the resize: wait for one way or the other.
  await page.waitFor(`document.querySelector('[data-testid=settings-tab-limits], [data-testid=nav-settings]')`);
  if (await page.evaluate<boolean>(`!document.querySelector('[data-testid=settings-tab-limits]')`)) {
    await page.click('[data-testid=nav-settings]');
  }
  await page.click('[data-testid=settings-tab-limits]');
  await page.waitFor(`document.querySelector('[data-testid=limits-page]')`);
}

/**
 * Leaves a phone settings page by its back arrow. The page pops its history entry with a `history.back()`
 * that lands in a later task: a navigation sent before it lands is cancelled, or swapped for an older
 * document from the back-forward cache, which freezes the page an evaluate is still waiting on.
 */
async function leavePhoneDetail() {
  const overlay = await page.evaluate<string | undefined>('history.state?.boiteOverlay');
  await page.click('[data-testid=mobile-settings-back]');
  const popped = overlay === undefined ? '' : ` && history.state?.boiteOverlay !== ${JSON.stringify(overlay)}`;
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')${popped}`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  origin = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${origin}/?fake=1`, windowSize: { width: 1280, height: 800 } });
  // A loaded runner lands a phone panel's history pop late, after the next navigation has started. Every
  // pop here is held until then, or 250 ms: a test that navigates before its pop landed fails each run.
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SLOW_BACK });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: STUCK_TRANSITION });
  await page.reload();
  await scheme('dark');
  await viewport(1280, 800);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('the desktop page charts each day by provider, reads a column on hover and keys, and lists models and threads', async () => {
  await openUsage();
  expect(await attribute('[data-testid=usage-chart]', 'aria-valuemax')).toBe('29');
  expect(await count('[data-testid=usage-providers] li')).toBeGreaterThanOrEqual(8);
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=usage-providers] li')].map(li => li.dataset.provider)`)).toEqual(expect.arrayContaining(['claude', 'codex', 'opencode', 'grok', 'antigravity', 'pi', 'muse']));
  expect(await page.text('[data-testid=usage-coverage]')).toContain('Cost');
  expect(await count('[data-testid=usage-threads] li')).toBe(10);
  const cards = await page.evaluate<{ inset: number; gap: number; width: number }>(`(() => {
    const overview = document.querySelector('[data-testid=usage-overview]');
    const next = overview.nextElementSibling;
    const box = overview.getBoundingClientRect();
    return { inset: overview.firstElementChild.getBoundingClientRect().left - box.left,
      gap: next.getBoundingClientRect().top - box.bottom, width: box.width };
  })()`);
  expect(cards.inset).toBeGreaterThanOrEqual(18);
  expect(cards.gap).toBeGreaterThanOrEqual(16);
  expect(cards.width).toBeLessThanOrEqual(880);
  await capture('usage-desktop-dark.png');

  await page.evaluate(`document.querySelector('[data-testid=usage-chart]').scrollIntoView({ block: 'center' })`);
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
  // Codex's own model has public rates now; Grok reports no tokens to price.
  expect(await page.text('[data-testid=usage-unpriced]')).toContain('Grok');
  expect(await page.text('[data-testid=usage-unpriced]')).not.toContain('Codex');
  expect(await page.text('[data-testid=usage-total]')).toMatch(/^\$/);
  await capture('usage-desktop-cost.png');

  // One row for a model recorded with and without its provider prefix, and its rates one "i" away.
  expect(await page.text('[data-testid=usage-breakdown]')).not.toContain('claude/claude-opus-5-5');
  await page.evaluate(`document.querySelector('[data-testid=usage-breakdown]').scrollIntoView({ block: 'center' })`);
  await page.click('[data-testid=usage-breakdown] tbody tr:first-child [data-testid=usage-price]');
  await page.waitFor(`document.querySelector('[data-testid=usage-price-text]')`);
  expect(await page.text('[data-testid=usage-price-text]')).toContain('Public API rates of claude-opus-5-5, per million tokens');
  await capture('usage-desktop-price.png');
  await page.click('[data-testid=usage-breakdown] tbody tr:first-child [data-testid=usage-price]');

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
  // The bar above names the page and carries its info mark; the page's own title steps aside,
  // and its refresh joins the bar's right end rather than taking a row of its own.
  expect(await page.evaluate(`document.querySelector('[data-testid=mobile-settings-info]').getBoundingClientRect().height > 0`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid=usage-page] > header h1').getBoundingClientRect().height`)).toBe(0);
  expect(await page.evaluate(`(() => {
    const info = document.querySelector('[data-testid=mobile-settings-info]').getBoundingClientRect();
    const refresh = document.querySelector('[data-testid=usage-refresh]').getBoundingClientRect();
    return refresh.top < info.bottom && refresh.bottom > info.top && refresh.right <= innerWidth;
  })()`)).toBe(true);
  await capture('usage-phone-dark.png');

  await page.click('[data-testid=usage-provider-filter]');
  await page.click('[data-testid=usage-provider-filter-menu] [data-value=muse]');
  await page.waitFor(`document.querySelectorAll('[data-testid=usage-providers] li').length === 1 && document.querySelector('[data-testid=usage-providers] li')?.dataset.provider === 'muse'`);
  expect(await page.text('[data-testid=usage-breakdown]')).toContain('Muse Code default');
  expect(await page.text('[data-testid=usage-breakdown]')).not.toContain('grok-code-fast-2');
  await page.evaluate(`document.querySelector('[data-testid=usage-page]').scrollIntoView({ block: 'start' })`);
  await page.click('[data-testid=usage-metric-cost]');
  await page.waitFor(`document.querySelector('[data-testid=usage-total]')?.textContent === 'No price'`);
  expect(await count('[data-testid=usage-chart]')).toBe(0);
  expect(await fits()).toBe(true);
  await capture('usage-phone-muse-unpriced.png');
  await page.click('[data-testid=usage-metric-tokens]');
  await page.click('[data-testid=usage-provider-filter]');
  await page.click('[data-testid=usage-provider-filter-menu] [data-value=""]');
  await page.waitFor(`document.querySelector('[data-testid=usage-chart] svg path')`);

  await page.evaluate(`document.querySelector('[data-testid=usage-chart]').scrollIntoView({ block: 'center' })`);
  const chart = await box('[data-testid=usage-chart]');
  await mouse(chart.left + chart.width / 2, chart.top + chart.height / 2);
  await page.waitFor(`document.querySelector('[data-testid=usage-tooltip]')`);
  const tip = await box('[data-testid=usage-tooltip]');
  expect(tip.left).toBeGreaterThanOrEqual(0);
  expect(tip.right).toBeLessThanOrEqual(390);
  await capture('usage-phone-tooltip.png');
  await mouse(2, 2);

  await page.evaluate(`document.querySelector('[data-testid=usage-breakdown]').scrollIntoView({ block: 'center' })`);
  await page.click('[data-testid=usage-breakdown] tbody tr:first-child [data-testid=usage-price]');
  await page.waitFor(`document.querySelector('[data-testid=usage-price-text]')`);
  const rates = await box('[data-testid=usage-price-text]');
  expect(rates.left).toBeGreaterThanOrEqual(0);
  expect(rates.right).toBeLessThanOrEqual(390);
  await capture('usage-phone-price.png');
  await page.click('[data-testid=usage-breakdown] tbody tr:first-child [data-testid=usage-price]');

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
  await leavePhoneDetail();
}, 60_000);

test('the limits tab is its own page, one card per account, no scrolling through the history', async () => {
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
  await leavePhoneDetail();
  await viewport(1280, 800);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('quotas expose banked resets, a confirmed budget and Codex credit balances on desktop and phone', async () => {
  await viewport(1280, 800);
  await page.navigate(`${origin}/?fake=1&quotaExtras=1`);
  await page.waitFor(`document.querySelector('[data-testid=nav-settings]')`);
  await page.click('[data-testid=nav-limits]');
  await page.waitFor(`document.querySelector('[data-testid=limits-glance] [data-testid=quota-credits]')`);
  const paid = '[data-testid=limits-glance] [data-provider=claude] [data-testid=quota-credits]';
  expect(await page.text(`${paid} .paid-label`)).toBe('Using credits');
  expect(await page.text(`${paid} .paid-amount`)).toBe('75%');
  expect(await attribute(`${paid} [role=meter]`, 'aria-valuenow')).toBe('75');
  expect(await page.text('[data-testid=limits-glance] [data-provider=codex] [data-testid=quota-credits]')).toContain('42 credits');
  expect(await count('[data-testid=limits-glance] [data-testid=quota-banked-resets]')).toBe(0);
  expect(await count('[data-testid=limits-glance] [data-testid=quota-use-reset]')).toBe(0);
  const barHeight = await page.evaluate<number>(`Math.max(...[...document.querySelectorAll('[data-testid=limits-glance] .summary [role=meter]')].map(el => el.getBoundingClientRect().height))`);
  expect(barHeight).toBeGreaterThan(4);
  expect(barHeight).toBeLessThanOrEqual(8);
  expect(await page.evaluate(`(() => { const r = document.querySelector('[data-testid=limits-glance]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })()`)).toBe(true);
  await capture('quota-extras-glance.png');
  await page.click('[data-testid=limits-glance] [data-provider=claude] .summary');
  await page.waitFor(`document.querySelector('[data-testid=limits-glance] [data-provider=claude] .details')`);
  expect(await count('[data-testid=limits-glance] [data-provider=claude] .details [role=meter]')).toBe(3);
  // The weekly window leads the account, ahead of the five-hour one.
  expect(await page.text('[data-testid=limits-glance] [data-provider=claude] .details .window-name')).toBe('Weekly');
  expect(await count('[data-testid=limits-glance] [data-testid=quota-banked-resets]')).toBe(0);
  await capture('quota-extras-glance-expanded.png');
  await page.click('[data-testid=limits-glance] [data-provider=codex] .summary');
  await page.waitFor(`document.querySelector('[data-testid=limits-glance] [data-provider=codex] .details')`);
  expect(await page.text('[data-testid=limits-glance] [data-provider=codex] [data-testid=quota-credits]')).toContain('42 credits');
  await capture('codex-credits-glance-expanded.png');
  await page.click('[data-testid=limits-glance-page]');
  await page.waitFor(`!document.querySelector('[data-testid=limits-glance]')`);
  await page.waitFor(`document.querySelector('[data-testid=limits-page]')`);
  await page.waitFor(`document.querySelector('[data-testid=quota-credits]')`);
  const claude = '[data-testid=usage-limit-provider][data-provider=claude]';
  const codex = '[data-testid=usage-limit-provider][data-provider=codex]';
  expect(await count(`${claude} [data-testid=quota-banked-resets]`)).toBeGreaterThan(0);
  expect(await count(`${codex} [data-testid=quota-banked-resets]`)).toBeGreaterThan(0);
  expect(await page.text(`${claude} [data-testid=quota-credits]`)).toContain('Monthly budget remaining');
  expect(await attribute(`${claude} [data-testid=quota-credits] [role=meter]`, 'aria-valuenow')).toBe('75');
  expect(await page.text(`${codex} [data-testid=quota-credits]`)).toContain('42 credits');
  expect(await count(`${claude} [data-testid=quota-use-reset]`)).toBe(1);
  expect(await count(`${codex} [data-testid=quota-use-reset]`)).toBe(1);
  expect(await count('[data-testid=quota-extras] button:not([data-testid=quota-use-reset])')).toBe(0);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('quota-extras-desktop.png');
  await scheme('light');
  await capture('quota-extras-desktop-light.png');
  await scheme('dark');
  await viewport(390, 844, true);
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-detail] [data-testid=quota-credits]')`);
  expect(await count(`${claude} [data-testid=quota-use-reset]`)).toBe(1);
  expect(await count(`${codex} [data-testid=quota-use-reset]`)).toBe(1);
  expect(await count(`${claude} [data-testid=quota-banked-resets]`)).toBeGreaterThan(0);
  expect(await count(`${codex} [data-testid=quota-banked-resets]`)).toBeGreaterThan(0);
  expect(await page.text(`${claude} [data-testid=quota-credits]`)).toContain('Monthly budget remaining');
  expect(await attribute(`${claude} [data-testid=quota-credits] [role=meter]`, 'aria-valuenow')).toBe('75');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-testid=quota-extras]')].every(el => el.getBoundingClientRect().right <= innerWidth)`)).toBe(true);
  await capture('quota-extras-phone.png');
  await scheme('light');
  await capture('quota-extras-phone-light.png');
  await scheme('dark');
  expect(await page.text(`${codex} [data-testid=quota-credits]`)).toContain('42 credits');
  await page.evaluate(`document.querySelector('${codex}').scrollIntoView({ block: 'center' })`);
  await capture('codex-credits-phone.png');
  await leavePhoneDetail();
  await viewport(1280, 800);
  await page.waitFor(`document.querySelector('[data-testid=settings-tab-limits]')`);
  await viewport(320, 560, true);
  await page.navigate(`${origin}/?fake=1&quotaExtras=1&view=quotas`);
  await page.waitFor(`document.querySelector('[data-testid=quota-popup] [data-testid=quota-credits]')`);
  expect(await page.text('[data-testid=quota-popup] [data-provider=claude] .paid-label')).toBe('Using credits');
  expect(await page.text('[data-testid=quota-popup] [data-provider=claude] .paid-amount')).toBe('75%');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('[data-testid=quota-extras]')].every(el => el.getBoundingClientRect().right <= innerWidth)`)).toBe(true);
  expect(await attribute('[data-testid=quota-popup] [data-provider=claude] [data-testid=quota-credits] [role=meter]', 'aria-valuenow')).toBe('75');
  expect(await page.text('[data-testid=quota-popup] [data-provider=codex] [data-testid=quota-credits]')).toContain('42 credits');
  expect(await count('[data-testid=quota-popup] [data-testid=quota-banked-resets]')).toBe(0);
  expect(await count('[data-testid=quota-popup] [data-testid=quota-use-reset]')).toBe(0);
  await capture('quota-extras-compact.png');
  await scheme('light');
  await capture('quota-extras-compact-light.png');
  await scheme('dark');
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(`${origin}/?fake=1&quotaExtras=1&view=quotas`);
  await page.waitFor(`document.documentElement.lang === 'fr' && document.querySelector('[data-testid=quota-popup] [data-provider=claude] .paid-label')?.textContent === 'Crédits utilisés'`);
  expect(await page.text('[data-testid=quota-popup] [data-provider=claude] .paid-amount')).toBe('75%');
  expect(await page.evaluate(`[...document.querySelectorAll('[data-testid=quota-popup] .paid-label, [data-testid=quota-popup] .paid-amount')].every(el => el.scrollWidth <= el.clientWidth)`)).toBe(true);
  await capture('quota-extras-compact-fr.png');
  await page.evaluate(`localStorage.setItem('boite.locale', 'en')`);
  await viewport(1280, 800);
  expect(page.errors()).toEqual([]);
}, 60_000);

test('a paired device reads the limit bars, without refresh or monitoring switches', async () => {
  await viewport(1280, 800);
  await page.navigate(`${origin}/?fake=1&principal=session`);
  await openLimits();
  await page.waitFor(`document.querySelectorAll('[data-testid=usage-limit-account]').length > 0`);
  expect(await count('[data-testid=limits-refresh]')).toBe(0);
  expect(await count('[data-testid=quota-monitor]')).toBe(0);
  expect(await count('[data-testid=limits-error]')).toBe(0);
  await capture('usage-device.png');
  expect(page.errors()).toEqual([]);
}, 60_000);
