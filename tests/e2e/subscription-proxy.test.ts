import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let gateway: ReturnType<typeof Bun.serve>;
let page: BrowserPage;
let origin: string;
let dashboard: string;
beforeAll(async () => {
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;background:rgb(24,24,28);color:white;padding:20px}article{border:1px solid rgb(90,90,95);padding:20px;max-width:480px;border-radius:10px}progress{width:100%}</style><h1>Subscription quotas</h1><article><h2>Codex subscription</h2><p>Weekly allowance: 72% remaining</p><progress value="72" max="100"></progress></article><p id="route">${new URL(request.url).pathname}</p></html>`, { headers: { 'content-type': 'text/html' } });
  } });
  dashboard = `http://127.0.0.1:${gateway.port}`;
  const port = await freePort(); server = await startDevUi(port); origin = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${origin}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); gateway?.stop(true); });

async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), name));
}

test('disabled mode retains the native glance; saving the proxy opens its embedded dashboard directly', async () => {
  await page.waitFor('document.querySelector("[data-testid=nav-limits]")');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=limits-glance]")');
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-accounts"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
  await page.click('[data-testid="subscription-proxy-enabled"]');
  await page.type('[data-testid="subscription-proxy-url"]', dashboard);
  await page.type('[data-testid="subscription-proxy-dashboard"]', `${dashboard}/admin/#quotas`);
  await capture('boite-proxy-settings-desktop.png');
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-result]")?.textContent.includes("saved")');
  await page.click('[data-testid="settings-back"]');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-dashboard-page]")');
  expect(await page.evaluate('document.querySelector("[data-testid=limits-glance]") === null')).toBe(true);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/admin/#quotas`)} && document.querySelector('[data-testid=subscription-proxy-slot]')?.getAttribute('aria-busy') === 'false'`);
  await capture('boite-proxy-dashboard-desktop.png');
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]").getBoundingClientRect().width > 600')).toBe(true);
  await page.click('[data-testid="subscription-proxy-configure"]');
  await page.waitFor('document.querySelector("iframe[data-browser-id]") === null');
  await page.click('[data-testid="subscription-proxy-cliproxyapi"]');
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-dashboard]").value')).toBe(`${dashboard}/management.html#/quota`);
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-result]")?.textContent.includes("saved")');
  await page.click('[data-testid="subscription-proxy-configure"]');
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)}`);
  expect(page.errors()).toEqual([]);
}, 45_000);

test('phone Limits opens the same gateway and disabling it restores the native page', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-detail]")');
  await page.click('[data-testid="mobile-settings-back"]');
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-home]")');
  await page.click('[data-testid="settings-tab-limits"]');
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)} && document.querySelector('[data-testid=subscription-proxy-slot]')?.getAttribute('aria-busy') === 'false'`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]").getBoundingClientRect().width <= 390')).toBe(true);
  await capture('boite-proxy-dashboard-phone.png');
  await page.click('[data-testid="subscription-proxy-configure"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
  await capture('boite-proxy-settings-phone.png');
  await page.click('[data-testid="subscription-proxy-enabled"]');
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-dashboard-page]") === null');
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]") === null')).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 30_000);
