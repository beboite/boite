import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
import { pairingUrlOf, startCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

let server: { close(): Promise<void> };
let gateway: ReturnType<typeof Bun.serve>;
let page: BrowserPage;
let origin: string;
let dashboard: string;
beforeAll(async () => {
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    // A gateway without Douane's quota route: Limits falls back to its dashboard.
    if (new URL(request.url).pathname.endsWith('/quotas')) return new Response('Not found', { status: 404 });
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

const saved = 'document.querySelector("[data-testid=subscription-proxy-result]")?.textContent.includes("saved")';
const gatewayRow = 'document.querySelector("[data-testid=account-gateway][data-provider=claude]")';
const showGatewayRow = `${gatewayRow} || document.querySelector("[data-testid=provider-settings][data-provider-id=claude] [data-testid=provider-details-toggle]").click()`;
const grokRow = 'document.querySelector("[data-testid=provider-settings][data-provider-id=grok]")';

test('disabled mode retains the native glance; Douane brings its quota bars and one gateway account', async () => {
  await page.waitFor('document.querySelector("[data-testid=nav-limits]")');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=limits-glance]")');
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-accounts"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-url]").value')).toBe('http://127.0.0.1:8787');
  await page.click('[data-testid="subscription-proxy-enabled"]');
  await page.type('[data-testid="subscription-proxy-url"]', dashboard);
  await page.type('[data-testid="subscription-proxy-dashboard"]', `${dashboard}/admin/#quotas`);
  expect(await page.text('[data-testid=subscription-proxy-enabled-hint]')).toContain('no longer used for Claude and Codex');
  await capture('boite-proxy-settings-desktop.png');
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor(saved);

  // Claude reads ready through the gateway, with one account and nothing to manage.
  await page.waitFor('document.querySelector("[data-testid=provider-settings][data-provider-id=claude]")?.textContent.includes("Ready · via Douane")');
  await page.evaluate(showGatewayRow);
  await page.waitFor(gatewayRow);
  expect(await page.text('[data-testid=account-gateway][data-provider=claude]')).toContain(dashboard);
  expect(await page.evaluate('document.querySelector("[data-testid=provider-settings][data-provider-id=claude]").querySelectorAll("[data-testid=account-row], [data-testid=account-add], [data-testid=account-gateway] button").length')).toBe(0);
  await page.evaluate(`${gatewayRow}.scrollIntoView({ block: 'center' })`);
  await capture('boite-proxy-gateway-account-desktop.png');

  // Douane serves Grok too, by its id: its row reads ready through the gateway.
  await page.waitFor(`${grokRow}?.textContent.includes("Ready · via Douane")`);
  await page.evaluate(`${grokRow}.scrollIntoView({ block: 'center' })`);
  await capture('boite-proxy-grok-desktop.png');

  // Limits shows Douane's own entries, grouped by provider, instead of its dashboard.
  await page.click('[data-testid="settings-tab-limits"]');
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 3');
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]") === null')).toBe(true);
  expect(await page.text('[data-testid=gateway-quotas][data-provider=antigravity]')).toContain('Antigravity · 10 accounts');
  await capture('boite-proxy-gateway-quotas-desktop.png');
  await page.click('[data-testid="settings-back"]');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=limits-glance]")');
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-dashboard-page]") === null')).toBe(true);
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=limits-glance]") === null');

  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-limits"]');
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 3');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-detail] [data-testid=gateway-quotas]")');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await capture('boite-proxy-gateway-quotas-phone.png');
  await page.send('Emulation.clearDeviceMetricsOverride', {});
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-detail]") === null');
  await page.click('[data-testid="settings-tab-accounts"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');

  // CLIProxyAPI has no quota route: Limits opens its embedded dashboard directly.
  await page.click('[data-testid="subscription-proxy-cliproxyapi"]');
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-dashboard]").value')).toBe(`${dashboard}/management.html#/quota`);
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor(saved);
  // CLIProxyAPI does not serve Grok: its row is back on its own sign-in while Claude stays on the gateway.
  await page.waitFor('document.querySelector("[data-testid=provider-settings][data-provider-id=claude]")?.textContent.includes("via CLIProxyAPI")');
  expect(await page.evaluate(`${grokRow}.textContent.includes("via CLIProxyAPI")`)).toBe(false);
  await page.click('[data-testid="settings-back"]');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-dashboard-page]")');
  expect(await page.evaluate('document.querySelector("[data-testid=limits-glance]") === null')).toBe(true);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)} && document.querySelector('[data-testid=subscription-proxy-slot]')?.getAttribute('aria-busy') === 'false'`);
  await capture('boite-proxy-dashboard-desktop.png');
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]").getBoundingClientRect().width > 600')).toBe(true);
  await page.click('[data-testid="subscription-proxy-native"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-opencode]")');
  expect(await page.evaluate('document.querySelector("[data-testid=quota-monitor][data-account-id=a-claude-main]") === null')).toBe(true);
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]") === null')).toBe(true);
  await page.click('[data-testid="quota-monitor"][data-account-id="a-opencode"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-opencode]")?.checked === false');
  await page.click('[data-testid="quota-monitor"][data-account-id="a-opencode"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-opencode]")?.checked === true');
  await capture('boite-proxy-native-limits-desktop.png');
  await page.click('[data-testid="subscription-proxy-show-dashboard"]');
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)}`);
  await page.click('[data-testid="subscription-proxy-configure"]');
  await page.waitFor('document.querySelector("iframe[data-browser-id]") === null');
  expect(page.errors()).toEqual([]);
}, 60_000);

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
  await page.click('[data-testid="subscription-proxy-native"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-opencode]")');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-show-dashboard]").getBoundingClientRect().top >= document.querySelector("[data-testid=settings] > header").getBoundingClientRect().bottom')).toBe(true);
  await capture('boite-proxy-native-limits-phone.png');
  await page.click('[data-testid="subscription-proxy-show-dashboard"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-dashboard-page]")');
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

test('production desktop and phone embed the dashboard through the real core without the fake bridge', async () => {
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let browser: BrowserPage | undefined;
  try {
    await client.call('settings.set', { subscriptionProxy: { enabled: true, kind: 'douane', baseUrl: dashboard, dashboardUrl: `${dashboard}/admin/#quotas` } });
    browser = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    const profileKey = JSON.stringify([client.core.hostname, client.core.dataDir, client.core.channel]);
    await browser.evaluate(`localStorage.setItem('boite.machine-profiles', ${JSON.stringify(JSON.stringify({ [profileKey]: { label: 'Test core' } }))})`);
    await browser.reload();
    await browser.click('[data-testid=nav-settings]');
    await browser.click('[data-testid=settings-tab-limits]');
    await browser.waitFor(`document.querySelector('[data-testid=subscription-proxy-slot] > iframe')?.src === ${JSON.stringify(`${dashboard}/admin/#quotas`)}`);
    expect(await browser.evaluate('new URLSearchParams(location.search).get("fake")')).toBeNull();
    expect(await browser.text('[data-testid=subscription-proxy-browser-hint]')).toContain('Sign in');
    await browser.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
    type FrameEntry = { frame: { id: string; url: string } };
    let child: FrameEntry | undefined;
    const deadline = Date.now() + 5_000;
    while (!child && Date.now() < deadline) {
      const tree = await browser.send('Page.getFrameTree', {}) as { frameTree: { childFrames?: FrameEntry[] } };
      child = tree.frameTree.childFrames?.find(entry => entry.frame.url.startsWith(dashboard));
      if (!child) await Bun.sleep(25);
    }
    if (!child) throw new Error('The gateway iframe did not finish navigating within 5 seconds');
    const world = await browser.send('Page.createIsolatedWorld', { frameId: child.frame.id }) as { executionContextId: number };
    const content = await browser.send('Runtime.evaluate', { contextId: world.executionContextId, expression: 'document.querySelector("h1")?.textContent', returnByValue: true }) as { result: { value: string } };
    expect(content.result.value).toBe('Subscription quotas');
    await browser.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), 'boite-proxy-production-desktop.png'));
    await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await browser.waitFor('document.querySelector("[data-testid=mobile-settings-detail]")');
    expect(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await browser.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
    await browser.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), 'boite-proxy-production-phone.png'));
    await browser.click('[data-testid=subscription-proxy-configure]');
    await browser.waitFor('document.querySelector("[data-testid=subscription-proxy-slot] > iframe") === null');
    expect(browser.errors()).toEqual([]);
  } finally { await browser?.close(); client.close(); await core.stop(); }
}, 60_000);
