import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
import { mobileAction, openLimitsTab } from './lib/mobile.ts';
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
afterAll(async () => { await page?.close(); await server?.close(); gateway?.stop(true); }, 30_000);

async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), name));
}

const saved = 'document.querySelector("[data-testid=subscription-proxy-result]")?.textContent.includes("saved")';
const gatewayRow = 'document.querySelector("[data-testid=account-gateway][data-provider=claude]")';
const showGatewayRow = `${gatewayRow} || document.querySelector("[data-testid=provider-settings][data-provider-id=claude] [data-testid=provider-details-toggle]").click()`;
const grokRow = 'document.querySelector("[data-testid=provider-settings][data-provider-id=grok]")';

async function expectOpenCodeGateways(name: 'Douane' | 'CLIProxyAPI') {
  for (const provider of ['opencode', 'opencode-v2']) {
    const row = `document.querySelector("[data-testid=provider-settings][data-provider-id=${provider}]")`;
    const gateway = `[data-testid=account-gateway][data-provider=${provider}]`;
    await page.waitFor(row);
    await page.evaluate(`document.querySelector(${JSON.stringify(gateway)}) || ${row}.querySelector("[data-testid=provider-details-toggle]").click()`);
    await page.waitFor(`document.querySelector(${JSON.stringify(gateway)})?.textContent.includes(${JSON.stringify(name)})`);
    expect(await page.evaluate(`document.querySelectorAll(${JSON.stringify(gateway)}).length`)).toBe(1);
    expect(await page.text(gateway)).toContain(dashboard);
    expect(await page.evaluate(`${row}.querySelectorAll("[data-testid=account-row], [data-testid=account-add], [data-testid=account-gateway] button").length`)).toBe(0);
    await page.evaluate(`${row}.scrollIntoView({ block: 'center' })`);
    await capture(`boite-proxy-${provider}-${name.toLowerCase()}-desktop.png`);
  }
}

async function expectNoNativeOpenCode() {
  expect(await page.evaluate('document.querySelectorAll("[data-testid=quota-monitor][aria-label^=OpenCode]").length')).toBe(0);
}

test('disabled mode retains the native glance; Douane brings its quota bars and one gateway account', async () => {
  await page.waitFor('document.querySelector("[data-testid=nav-limits]")');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=limits-glance]")');
  await page.click('[data-testid="nav-settings"]');
  await page.click('[data-testid="settings-tab-accounts"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
  // The experimental OpenCode member is off in the fixture until enabled here.
  await page.click('[data-testid="provider-settings"][data-provider-id="opencode"] [data-testid="provider-details-toggle"]');
  await page.click('[data-testid="provider-enabled"][data-provider-id="opencode-v2"]');
  await page.waitFor('document.querySelector("[data-testid=provider-enabled][data-provider-id=opencode-v2]")?.checked === true');
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-url]").value')).toBe('http://127.0.0.1:8787');
  await page.click('[data-testid="subscription-proxy-enabled"]');
  await page.type('[data-testid="subscription-proxy-url"]', dashboard);
  await page.type('[data-testid="subscription-proxy-dashboard"]', `${dashboard}/admin/#quotas`);
  expect(await page.text('[data-testid=subscription-proxy-enabled-hint]')).toContain('no longer used for Claude and Codex');
  await capture('boite-proxy-settings-desktop.png');
  await page.click('[data-testid="subscription-proxy-save"]');
  await page.waitFor(saved);

  // The saved Douane opens in the browser, and this machine's logins move into it from the same card.
  expect(await page.text('[data-testid=subscription-proxy-settings] [data-testid=subscription-proxy-open]')).toBe('Open Douane');
  const moveRow = (id: string) => `document.querySelector('[data-testid=gateway-move-row][data-id="${id}"]')`;
  await page.click('[data-testid="gateway-move-open"]');
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-move-row]").length > 3');
  expect(await page.evaluate(`${moveRow('a-opencode:key:groq')}.textContent`)).toContain('No known API address');
  await capture('boite-proxy-move-desktop.png');
  await page.click('[data-testid="gateway-move-confirm"]');
  await page.waitFor(`${moveRow('a-opencode:key:deepseek')}?.textContent.includes("Moved")`);
  expect(await page.evaluate(`${moveRow('a-opencode:key:opencode')}.textContent`)).toContain('Refused');
  await capture('boite-proxy-moved-desktop.png');
  await page.click('[data-testid="gateway-move-close"]');
  await page.waitFor('document.querySelector("[data-testid=gateway-move-dialog]") === null');
  // A second move adds nothing twice.
  await page.click('[data-testid="gateway-move-open"]');
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-move-row]").length > 3');
  await page.click('[data-testid="gateway-move-confirm"]');
  await page.waitFor(`${moveRow('a-opencode:key:deepseek')}?.textContent.includes("Already there")`);
  await page.click('[data-testid="gateway-move-close"]');
  await page.waitFor('document.querySelector("[data-testid=gateway-move-dialog]") === null');

  // Claude reads ready through the gateway, with one account and nothing to manage.
  await page.waitFor('document.querySelector("[data-testid=provider-settings][data-provider-id=claude]")?.textContent.includes("Ready · via Douane")');
  await page.evaluate(showGatewayRow);
  await page.waitFor(gatewayRow);
  expect(await page.text('[data-testid=account-gateway][data-provider=claude]')).toContain(dashboard);
  expect(await page.evaluate('document.querySelector("[data-testid=provider-settings][data-provider-id=claude]").querySelectorAll("[data-testid=account-row], [data-testid=account-add], [data-testid=account-gateway] button").length')).toBe(0);
  await page.evaluate(`${gatewayRow}.scrollIntoView({ block: 'center' })`);
  await capture('boite-proxy-gateway-account-desktop.png');
  await expectOpenCodeGateways('Douane');

  // Douane serves Grok too, by its id: its row reads ready through the gateway.
  await page.waitFor(`${grokRow}?.textContent.includes("Ready · via Douane")`);
  await page.evaluate(`${grokRow}.scrollIntoView({ block: 'center' })`);
  await capture('boite-proxy-grok-desktop.png');

  // Limits shows Douane's own entries, grouped by provider, instead of its dashboard.
  await openLimitsTab(page);
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 4');
  expect(await page.evaluate('Array.from(document.querySelectorAll("[data-testid=gateway-quotas]"), group => group.dataset.provider)')).toEqual(['claude', 'codex', 'antigravity', 'meta']);
  expect(await page.text('[data-testid=gateway-quotas][data-provider=meta]')).toContain('Muse Code subscription');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=gateway-quotas][data-provider=meta] [role=meter]").length')).toBe(0);
  await expectNoNativeOpenCode();
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
  await openLimitsTab(page);
  await page.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 4');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-detail] [data-testid=gateway-quotas]")');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  // This browser reaches its core at a loopback address: the loopback dashboard opens from here.
  expect(await page.text('[data-testid=mobile-settings-detail] [data-testid=subscription-proxy-open]')).toBe('Open Douane');
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
  await expectOpenCodeGateways('CLIProxyAPI');
  await page.click('[data-testid="settings-back"]');
  await page.click('[data-testid="nav-limits"]');
  await page.waitFor('document.querySelector("[data-testid=subscription-proxy-dashboard-page]")');
  expect(await page.evaluate('document.querySelector("[data-testid=limits-glance]") === null')).toBe(true);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)} && document.querySelector('[data-testid=subscription-proxy-slot]')?.getAttribute('aria-busy') === 'false'`);
  await capture('boite-proxy-dashboard-desktop.png');
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]").getBoundingClientRect().width > 600')).toBe(true);
  await page.click('[data-testid="subscription-proxy-native"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-grok]")');
  await expectNoNativeOpenCode();
  expect(await page.evaluate('document.querySelector("[data-testid=quota-monitor][data-account-id=a-claude-main]") === null')).toBe(true);
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]") === null')).toBe(true);
  await page.click('[data-testid="quota-monitor"][data-account-id="a-grok"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-grok]")?.checked === false');
  await page.click('[data-testid="quota-monitor"][data-account-id="a-grok"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-grok]")?.checked === true');
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
  await openLimitsTab(page);
  await page.waitFor(`document.querySelector('iframe[data-browser-id]')?.src === ${JSON.stringify(`${dashboard}/management.html#/quota`)} && document.querySelector('[data-testid=subscription-proxy-slot]')?.getAttribute('aria-busy') === 'false'`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]").getBoundingClientRect().width <= 390')).toBe(true);
  await capture('boite-proxy-dashboard-phone.png');
  await page.click('[data-testid="subscription-proxy-native"]');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-grok]")');
  await expectNoNativeOpenCode();
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-show-dashboard]").getBoundingClientRect().top >= document.querySelector("[data-testid=mobile-settings-header]").getBoundingClientRect().bottom')).toBe(true);
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
  await page.click('[data-testid="mobile-settings-back"]');
  await page.waitFor('document.querySelector("[data-testid=mobile-settings-home]")');
  await openLimitsTab(page);
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-opencode]")?.checked === true');
  await page.waitFor('document.querySelector("[data-testid=quota-monitor][data-account-id=a-grok]")?.checked === true');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=quota-monitor][aria-label^=OpenCode]").length')).toBe(2);
  expect(await page.evaluate('document.querySelector("[data-testid=subscription-proxy-dashboard-page]") === null')).toBe(true);
  expect(await page.evaluate('document.querySelector("iframe[data-browser-id]") === null')).toBe(true);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await capture('boite-proxy-disabled-native-limits-phone.png');
  expect(page.errors()).toEqual([]);
}, 30_000);

test('a paired phone switches the gateway the owner saved, on and off, from Limits', async () => {
  const phone = await BrowserPage.launch({ url: `${origin}/?fake=1&principal=session&open=recent&gateway=douane`, windowSize: { width: 390, height: 844 } });
  const shot = async (name: string) => {
    await phone.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
    await phone.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), name));
  };
  const input = '[data-testid=mobile-settings-detail] [data-testid=gateway-switch-input]';
  try {
    await phone.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await phone.waitFor('document.querySelector("[data-testid=mobile-header]")');
    await mobileAction(phone, 'mobile-settings');
    await openLimitsTab(phone);
    await phone.waitFor(`document.querySelector(${JSON.stringify(input)})?.checked === false`);
    expect(await phone.text('[data-testid=gateway-switch]')).toContain('Use Douane');
    expect(await phone.text('[data-testid=gateway-switch]')).toContain('https://gateway.example.test');
    // The owner's form stays on the desktop.
    expect(await phone.evaluate('document.querySelector("[data-testid=subscription-proxy-settings]") === null')).toBe(true);
    await shot('boite-gateway-switch-off-phone.png');
    await phone.click(input);
    await phone.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 4');
    expect(await phone.evaluate(`document.querySelector(${JSON.stringify(input)}).checked`)).toBe(true);
    expect(await phone.evaluate('document.querySelector("[data-testid=gateway-switch-error]") === null')).toBe(true);
    expect(await phone.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await shot('boite-gateway-switch-on-phone.png');
    await phone.click(input);
    await phone.waitFor('document.querySelectorAll("[data-testid=gateway-quotas]").length === 0');
    expect(await phone.evaluate(`document.querySelector(${JSON.stringify(input)}).checked`)).toBe(false);
    expect(phone.errors()).toEqual([]);
  } finally { await phone.close(); }
}, 45_000);

test('the Douane plugin: its row in Plugins and the proxy card pointing at it, at desktop and phone widths', async () => {
  const local = await BrowserPage.launch({ url: `${origin}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
  const shot = async (name: string) => {
    await local.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
    await local.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), name));
  };
  // The list above can still grow as rows land: scroll until the element stays in view.
  // One page-side helper, then fixed expressions naming it: no expression is built from a value.
  const scrolled = 'window.__inView = (selector) => { const el = document.querySelector(selector); if (!el) return false; el.scrollIntoView({ block: "center" }); const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }';
  const stripInView = 'window.__inView("[data-testid=plugin-gateway][data-plugin=douane]")';
  const stripRunning = 'document.querySelector("[data-testid=plugin-gateway][data-plugin=douane]")?.dataset.gatewayStatus === "running"';
  try {
    await local.waitFor('document.querySelector("[data-testid=nav-settings]")');
    await local.click('[data-testid="nav-settings"]');
    await local.click('[data-testid="settings-tab-plugins"]');
    await local.evaluate(scrolled);
    await local.waitFor(stripRunning);
    expect(await local.text('[data-testid=plugin-gateway][data-plugin=douane] [data-testid=plugin-gateway-state]')).toContain('0.3.0 on 127.0.0.1:8787');
    expect(await local.evaluate('!!document.querySelector("[data-testid=plugin-gateway-open][data-plugin=douane]")')).toBe(true);
    await local.waitFor(stripInView);
    await shot('boite-douane-plugin-desktop.png');

    await local.click('[data-testid="settings-tab-accounts"]');
    await local.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
    await local.click('[data-testid="subscription-proxy-local"]');
    await local.waitFor('document.querySelector("[data-testid=subscription-proxy-plugin]")?.dataset.state === "running"');
    await local.click('[data-testid="subscription-proxy-enabled"]');
    await local.click('[data-testid="subscription-proxy-save"]');
    await local.waitFor('document.querySelector("[data-testid=subscription-proxy-result]")?.textContent.includes("saved")');
    expect(await local.text('[data-testid=subscription-proxy-plugin]')).toContain('Douane 0.3.0 answers on 127.0.0.1:8787.');
    await local.waitFor('window.__inView("[data-testid=subscription-proxy-settings]")');
    await shot('boite-douane-proxy-desktop.png');

    // The phone has no Plugins page (plugins are the desktop's to manage): the proxy card under Limits.
    await local.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await local.waitFor('document.querySelector("[data-testid=mobile-header]")');
    await mobileAction(local, 'mobile-settings');
    await local.waitFor('document.querySelector("[data-testid=mobile-settings-home]")');
    await local.click('[data-testid="settings-tab-usage"]');
    await local.click('[data-testid="mobile-usage-tab-limits"]');
    await local.waitFor('document.querySelector("[data-testid=subscription-proxy-settings]")');
    await local.evaluate('document.querySelector("[data-testid=subscription-proxy-settings]").closest("details").open = true');
    await local.waitFor('document.querySelector("[data-testid=subscription-proxy-plugin]")?.dataset.state === "running"');
    await local.waitFor('window.__inView("[data-testid=subscription-proxy-plugin]")');
    expect(await local.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await shot('boite-douane-proxy-phone.png');
    expect(local.errors()).toEqual([]);
  } finally { await local.close(); }
}, 45_000);

test('production desktop and phone embed the dashboard through the real core without the fake bridge', async () => {
  const core = await startCore();
  const client = await connect(core.url, core.token);
  let browser: BrowserPage | undefined;
  try {
    await client.call('settings.set', { subscriptionProxy: { enabled: true, kind: 'douane', baseUrl: dashboard, dashboardUrl: `${dashboard}/admin/#quotas` } });
    browser = await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 900 } });
    // Reproduce a loaded runner: the page loads before its first authenticated hello completes.
    const { identifier: slowHello } = await browser.send('Page.addScriptToEvaluateOnNewDocument', { source: `{
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        if (typeof data !== 'string' || JSON.parse(data).method !== 'hello') return send.call(this, data);
        setTimeout(() => { if (this.readyState === WebSocket.OPEN) send.call(this, data); }, 1500);
      };
    }` }) as { identifier: string };
    await browser.navigate(pairingUrlOf(core));
    await browser.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: slowHello });
    // The token leaves the URL before hello; it is remembered only once the connection is ready.
    await browser.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`);
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
    // The frame reports its URL once the navigation commits, before its
    // document is parsed: read the heading until it is there.
    let heading: string | undefined;
    while (Date.now() < deadline + 5_000) {
      const world = await browser.send('Page.createIsolatedWorld', { frameId: child.frame.id }) as { executionContextId: number };
      const content = await browser.send('Runtime.evaluate', { contextId: world.executionContextId, expression: 'document.querySelector("h1")?.textContent', returnByValue: true }) as { result: { value?: string } };
      heading = content.result.value;
      if (heading) break;
      await Bun.sleep(25);
    }
    expect(heading).toBe('Subscription quotas');
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
