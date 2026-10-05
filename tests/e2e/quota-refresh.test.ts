import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
import { startTestCore } from '../../packages/core/test/harness.ts';
import type { AccountQuota } from '../../packages/contracts/src/index.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let origin: string;
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  origin = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${origin}/?fake=1`, windowSize: { width: 1280, height: 900 } });
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); });

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), name));
}

test('limits identify the owning machine in the desktop glance and desktop and phone pages', async () => {
  for (const width of [1280, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
    await page.navigate(`${origin}/?fake=1&open=recent&machines=1`);
    await page.waitFor('globalThis.__boiteTest?.workspace.machines.length === 2');
    await page.evaluate(`(async () => {
      const workspace = globalThis.__boiteTest.workspace;
      const local = workspace.machines[0].store;
      const remote = workspace.machines[1];
      local.localCore = true;
      globalThis.quotaScopeCalls = [];
      for (const machine of workspace.machines) {
        const call = machine.store.client.call.bind(machine.store.client);
        machine.store.client.call = (method, params) => {
          if (method === 'quotas.list') globalThis.quotaScopeCalls.push(machine.id);
          return call(method, params);
        };
      }
      await workspace.select(remote.store, 't-trace');
    })()`);
    const scope = '[data-testid="quota-machine-scope"]';
    if (width === 1280) await page.click('[data-testid="nav-limits"]');
    else {
      await page.click('[data-testid="nav-settings"]');
      await page.click('[data-testid="settings-tab-limits"]');
    }
    await page.waitFor(`document.querySelector('${scope}')?.dataset.remote === 'true'`);
    expect((await page.text(scope)).trim()).toBe('Account limits for Builder');
    // Machine context replaces the heading instead of repeating it below.
    expect(await page.evaluate(`document.querySelectorAll('${scope}').length === 1 && !!document.querySelector('${scope}')?.closest('h1, h2')?.getClientRects().length`)).toBe(true);
    const refresh = width === 1280 ? 'limits-glance-refresh' : 'limits-refresh';
    await page.click(`[data-testid="${refresh}"]`);
    await page.waitFor(`document.querySelector('[data-testid="${refresh}"]')?.getAttribute('aria-busy') === 'false'`);
    expect(await page.evaluate('globalThis.quotaScopeCalls.every(id => id === "http://builder.test") && globalThis.quotaScopeCalls.length > 0')).toBe(true);
    if (width === 1280) {
      await capture(`quota-remote-glance-${width}.png`);
      await page.click('[data-testid="limits-glance-page"]');
    }
    await page.waitFor(`document.querySelector('[data-testid="limits-page"]')`);
    const heading = width === 1280 ? '[data-testid="limits-page"] h1' : '[data-testid="settings"] > header h1';
    expect((await page.text(heading)).trim()).toBe('Account limits for Builder');
    expect(await page.evaluate(`document.querySelector('${heading}')?.getClientRects().length > 0`)).toBe(true);
    // A renamed machine remains identifiable even on a narrow phone.
    await page.evaluate(`globalThis.__boiteTest.workspace.customize('http://builder.test', 'Build server for shared development projects')`);
    await page.waitFor(`document.querySelector('${scope}')?.textContent.includes('Build server for shared development projects')`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await capture(`quota-remote-page-${width}.png`);
    await page.evaluate(`(async () => {
      const workspace = globalThis.__boiteTest.workspace;
      await workspace.select(workspace.machines[0].store);
      workspace.active.showSettings('limits');
    })()`);
    await page.waitFor(`document.querySelector('${scope}')?.dataset.remote === 'false'`);
    expect(await page.text(scope)).not.toContain('Build server');
    expect(page.errors()).toEqual([]);
    await page.evaluate(`localStorage.removeItem('boite.machine-profiles')`);
  }
}, 60_000);

for (const view of ['tray', 'desktop', 'phone', 'sidebar']) {
  test(`${view} restores each quota bar as its account answers`, async () => {
    // Windows runners may request reduced motion at the OS level.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width: view === 'desktop' || view === 'sidebar' ? 1280 : 390, height: 850, deviceScaleFactor: 1, mobile: view === 'phone' });
    await page.navigate(`${origin}/?fake=1&open=recent${view === 'tray' ? '&view=quotas' : ''}`);
    if (view === 'sidebar') {
      await page.click('[data-testid="nav-limits"]');
    } else if (view !== 'tray') {
      await page.click('[data-testid="nav-settings"]');
      await page.click('[data-testid="settings-tab-limits"]');
    }
    const refresh = `[data-testid="${view === 'tray' ? 'quota' : view === 'sidebar' ? 'limits-glance' : 'limits'}-refresh"]`;
    await page.waitFor(`document.querySelector('${refresh}')?.getAttribute('aria-busy') === 'false' && document.querySelector('[role="meter"]')`);
    // Hold the RPC's final response and deliver individual account events ourselves.
    // This controls network timing without changing the reader or either view.
    await page.evaluate(`(async () => {
      const { FakeClient } = await import('/src/lib/fake-client.ts');
      const call = FakeClient.prototype.call;
      const on = FakeClient.prototype.on;
      FakeClient.prototype.on = function(name, handler) {
        if (name === 'quotas.progress') globalThis.quotaProgress = handler;
        return on.call(this, name, handler);
      };
      FakeClient.prototype.call = async function(method, params) {
        if (method !== 'quotas.list') return call.call(this, method, params);
        const rows = await call.call(this, method, {});
        return new Promise(resolve => { globalThis.quotaFixture = { rows, requestId: params.requestId, resolve }; });
      };
    })()`);
    await page.click(refresh);
    await page.waitFor('globalThis.quotaFixture');
    const root = view === 'tray' || view === 'sidebar' ? '[data-testid="quota-provider"]' : '[data-testid="usage-limit-account"]';
    const track = (provider: string) => `${root}[data-provider="${provider}"] .track`;
    const filter = (provider: string) => page.evaluate<string>(`getComputedStyle(document.querySelector('${track(provider)}')).filter`);
    await capture(`quota-${view}-waiting.png`);
    expect(await filter('claude')).toBe('saturate(0.15)');
    expect(await filter('codex')).toBe('saturate(0.15)');
    expect(await page.evaluate(`getComputedStyle(document.querySelector('${track('claude')}')).animationName`)).toBe('none');
    await page.evaluate(`(() => {
      const fixture = globalThis.quotaFixture;
      for (const row of fixture.rows.filter(row => row.providerId === 'claude')) {
        row.windows = row.windows.map(window => ({ ...window, usedPercent: 75 }));
        globalThis.quotaProgress({ requestId: fixture.requestId, quota: row });
      }
    })()`);
    // A refresh pressed by hand looks busy for one turn of its icon, even for an account that already answered.
    expect(await filter('claude')).toBe('saturate(0.15)');
    await page.waitFor(`getComputedStyle(document.querySelector('${track('claude')}')).filter === 'saturate(1)'`);
    await capture(`quota-${view}-partial.png`);
    expect(await filter('codex')).toBe('saturate(0.15)');
    expect(await page.evaluate(`document.querySelector('${refresh}').getAttribute('aria-busy')`)).toBe('true');
    expect(await page.evaluate(`document.querySelector('${track('claude')} .fill').style.width`)).toBe('25%');
    expect(await page.evaluate(`getComputedStyle(document.querySelector('${track('claude')} .fill')).transitionProperty`)).toContain('width');
    await page.evaluate('globalThis.quotaFixture.resolve(globalThis.quotaFixture.rows)');
    await page.waitFor(`document.querySelector('${refresh}').getAttribute('aria-busy') === 'false'`);
    await capture(`quota-${view}-ready.png`);
    expect(await filter('codex')).toBe('saturate(1)');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page.evaluate(`getComputedStyle(document.querySelector('${track('claude')} .fill')).transitionProperty`)).toBe('none');
  }, 60_000);
}

test('quota failures name the provider error at desktop and phone widths', async () => {
  for (const width of [1280, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
    await page.navigate(`${origin}/?fake=1&view=quotas`);
    await page.waitFor('document.querySelector("[data-testid=quota-refresh]")?.getAttribute("aria-busy") === "false"');
    await page.evaluate(`(async () => {
      const { FakeClient } = await import('/src/lib/fake-client.ts');
      const call = FakeClient.prototype.call;
      FakeClient.prototype.call = function(method, params) {
        if (method !== 'quotas.list') return call.call(this, method, params);
        return Promise.resolve([{ accountId: 'grok-default', providerId: 'grok', providerName: 'Grok', label: 'Default', enabled: true, status: 'unavailable', windows: [], checkedAt: null, error: 'Grok login is missing or expired. Run grok login, then refresh.' }]);
      };
    })()`);
    await page.click('[data-testid=quota-refresh]');
    await page.waitFor('document.querySelector("[data-provider=grok] [role=status]")');
    expect(await page.evaluate('document.querySelector("[data-provider=grok] [role=status]").textContent')).toContain('Run grok login');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await capture(`quota-grok-error-${width}.png`);
  }
}, 60_000);

for (const width of [1280, 390]) {
  test(`subscription names and separate rows survive rename at ${width}px`, async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
    await page.navigate(`${origin}/?fake=1&open=recent`);
    await page.click('[data-testid="nav-settings"]');
    await page.click('[data-testid="settings-tab-limits"]');
    await page.waitFor(`document.querySelector('[data-testid="limits-refresh"]')?.getAttribute('aria-busy') === 'false'`);
    expect(await page.evaluate(`document.querySelector('[data-testid="usage-limit-provider"][data-account-id="a-codex"] strong').textContent`)).toBe('Default');
    const tracked = '[data-testid="tracked-account"][data-account-id="a-codex"]';
    await page.click(`${tracked} [data-testid="account-rename"]`);
    await page.waitFor(`document.activeElement?.getAttribute('data-testid') === 'account-name'`);
    await page.type(`${tracked} [data-testid="account-name"]`, 'Personal subscription with a deliberately long account name');
    await capture(`subscription-rename-${width}.png`);
    await page.click(`${tracked} [data-testid="account-save"]`);
    await page.waitFor(`document.querySelector('[data-testid="usage-limit-provider"][data-account-id="a-codex"] strong')?.textContent.startsWith('Personal subscription')`);
    await page.evaluate(`(async () => {
      const store = globalThis.__boiteTest.workspace.active;
      const account = await store.addAccount({ providerId: 'codex', label: 'Work', useDefaultLocation: false });
      await store.client.call('accounts.login', { accountId: account.id });
    })()`);
    await page.waitFor(`globalThis.__boiteTest.workspace.active.accounts.some(account => account.providerId === 'codex' && account.label === 'Work' && account.status === 'ok')`);
    await page.click('[data-testid="limits-refresh"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="usage-limit-provider"][data-provider="codex"]').length === 2`);
    await page.evaluate(`document.querySelector('[data-testid="usage-limit-provider"][data-account-id="a-codex"]').scrollIntoView({ block: 'center' })`);
    await capture(`subscription-cards-${width}.png`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    if (width === 390) return;
    // The sidebar uses the tray's component and retains both account labels.
    await page.evaluate(`globalThis.__boiteTest.workspace.active.showChat()`);
    await page.click('[data-testid="nav-limits"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"]').length === 2`);
    const names = await page.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"] .name')].map(row => row.textContent)`);
    expect(names).toEqual(['Personal subscription with a deliberately long account name', 'Work']);
    await page.click('[data-testid="quota-provider"][data-provider="codex"] .summary');
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"][data-provider="codex"] .details')`);
    await capture(`subscription-lines-${width}.png`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate(`(() => { const body = document.querySelector('[data-testid="limits-glance"] .body'); return body.scrollWidth <= body.clientWidth; })()`)).toBe(true);
  }, 60_000);
}


test('the tray follows account renames immediately and keeps subscriptions separate', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 650, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`localStorage.removeItem('boite.quotas')`);
  await page.navigate(`${origin}/?fake=1&view=quotas&quotaExtras=1`);
  await page.waitFor(`document.querySelector('[data-testid="quota-refresh"]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name')?.textContent === 'Default'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name').textContent`)).toBe('Default');
  await page.evaluate(`(async () => {
    const { FakeClient } = await import('/src/lib/fake-client.ts');
    const call = FakeClient.prototype.call;
    FakeClient.prototype.call = async function(method, params) {
      globalThis.trayClient = this;
      const result = await call.call(this, method, params);
      if (method === 'accounts.list' && globalThis.holdAccounts) {
        return new Promise(resolve => { globalThis.releaseAccounts = () => resolve(result); });
      }
      return result;
    };
  })()`);
  await page.click('[data-testid="quota-refresh"]');
  await page.waitFor(`globalThis.trayClient && document.querySelector('[data-testid="quota-refresh"]').getAttribute('aria-busy') === 'false'`);
  await page.evaluate(`globalThis.holdAccounts = true`);
  await page.click('[data-testid="quota-refresh"]');
  await page.waitFor('globalThis.releaseAccounts');
  await page.evaluate(`globalThis.trayClient.call('accounts.rename', { accountId: 'a-codex', label: 'Personal subscription with a deliberately long account name' })`);
  // The account event updates the name even before any quota read.
  await page.waitFor(`document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name').textContent.startsWith('Personal subscription')`);
  await page.evaluate(`globalThis.holdAccounts = false; globalThis.releaseAccounts()`);
  // The snapshot was captured before the rename: releasing it must retain the event's label.
  await page.waitFor(`!globalThis.holdAccounts && document.querySelector('[data-testid="quota-refresh"]').getAttribute('aria-busy') === 'false'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name').textContent`)).toContain('Personal subscription');
  await page.evaluate(`(async () => {
    const account = await globalThis.trayClient.call('accounts.add', { providerId: 'codex', label: 'Work', useDefaultLocation: false });
    await globalThis.trayClient.call('accounts.login', { accountId: account.id });
  })()`);
  await page.waitFor(`globalThis.trayClient.call('accounts.list', {}).then(accounts => accounts.some(account => account.label === 'Work' && account.status === 'ok'))`);
  await page.click('[data-testid="quota-refresh"]');
  await page.waitFor(`document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"]').length === 2`);
  await capture('subscription-tray.png');
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"] [data-testid="quota-credits"]').length`)).toBe(2);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"] [data-testid="quota-extras"] .account').length`)).toBe(0);
  expect(await page.evaluate(`document.querySelector('section').scrollWidth <= document.querySelector('section').clientWidth`)).toBe(true);
  const personal = '[data-testid="quota-provider"][data-account-id="a-codex"]';
  await page.click(`${personal} .summary`);
  await capture('subscription-tray-expanded.png');
  expect(await page.evaluate(`document.querySelectorAll('${personal} .details [role="meter"]').length`)).toBe(2);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="quota-provider"][data-provider="codex"]')[1].querySelector('.details')`)).toBeNull();
}, 60_000);

for (const width of [1280, 390]) {
  test(`banked resets require confirmation and consume only the selected fake account at ${width}px`, async () => {
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
    await page.navigate(`${origin}/?fake=1&open=recent&quotaExtras=1`);
    await page.click('[data-testid="nav-settings"]');
    await page.click('[data-testid="settings-tab-limits"]');
    const codex = '[data-testid="usage-limit-provider"][data-account-id="a-codex"]';
    const claude = '[data-testid="usage-limit-provider"][data-account-id="a-claude-main"]';
    const reset = `${codex} [data-testid="quota-use-reset"]`;
    await page.waitFor(`document.querySelector('${reset}')?.disabled === false`);
    const historyDepth = await page.evaluate<number>('history.state?.boiteDepth ?? 0');
    await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('accounts.rename', { accountId: 'a-codex', label: 'Work subscription' })`);
    await page.waitFor(`document.querySelector('${codex} strong').textContent === 'Work subscription'`);
    await page.evaluate(`document.querySelector('${codex}').scrollIntoView({ block: 'center' })`);
    await capture(`quota-reset-limits-${width}.png`);
    // This page has only an in-memory transport. Hold its response after its
    // broadcast to exercise repeated clicks and the account's refreshed row.
    await page.evaluate(`(async () => {
      const { FakeClient } = await import('/src/lib/fake-client.ts');
      const call = FakeClient.prototype.call;
      globalThis.resetCalls = [];
      FakeClient.prototype.call = async function(method, params) {
        if (method !== 'quotas.reset') return call.call(this, method, params);
        globalThis.resetCalls.push(params);
        const result = await call.call(this, method, params);
        if (globalThis.holdReset) return new Promise(resolve => { globalThis.releaseReset = () => resolve(result); });
        return result;
      };
    })()`);
    await page.click(reset);
    await page.waitFor(`document.activeElement?.getAttribute('data-testid') === 'confirm-cancel'`);
    expect(await page.evaluate(`document.querySelector('[data-testid="confirm-dialog"]').textContent`)).toContain('cannot be undone');
    expect(await page.evaluate(`document.querySelector('[data-testid="confirm-dialog"]').textContent`)).toContain('closest to expiring');
    expect(await page.evaluate(`document.querySelector('[data-testid="confirm-dialog"]').textContent`)).toContain('Work subscription');
    expect(await page.evaluate('globalThis.resetCalls.length')).toBe(0);
    await capture(`quota-reset-confirm-${width}.png`);
    // Enter on the initially focused Cancel, Escape and a scrim click spend nothing.
    // Enter's character is required for Chrome to activate the native button.
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.click(reset);
    await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.click(reset);
    await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.evaluate(`document.querySelector('[data-testid="confirm-dialog"]').parentElement.click()`);
    await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
    expect(await page.evaluate('globalThis.resetCalls.length')).toBe(0);
    await page.evaluate('globalThis.holdReset = true');
    await page.click(reset);
    await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.click('[data-testid="confirm-ok"]');
    await page.waitFor('globalThis.releaseReset');
    expect(await page.evaluate(`document.querySelector('${reset}').disabled`)).toBe(true);
    await page.evaluate(`document.querySelector('${reset}').click(); document.querySelector('${reset}').click()`);
    expect(await page.evaluate('globalThis.resetCalls')).toEqual([{ accountId: 'a-codex', confirmed: true }]);
    await page.evaluate('globalThis.holdReset = false; globalThis.releaseReset()');
    await page.waitFor(`document.querySelector('${codex} [data-testid="quota-reset-status"]')?.textContent.includes('Reset applied')`);
    expect(await page.evaluate(`document.querySelector('${codex} .window .fill').style.width`)).toBe('100%');
    expect(await page.evaluate(`document.querySelector('${claude} .window .fill').style.width`)).toBe('0%');
    expect(await page.evaluate(`document.querySelector('${codex} .reserve').textContent`)).toContain('1 banked reset');
    await capture(`quota-reset-applied-${width}.png`);
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    // A second confirmation when limits are clear does not consume the remaining credit.
    await page.click(reset);
    await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
    await page.click('[data-testid="confirm-ok"]');
    await page.waitFor(`document.querySelector('${codex} [data-testid="quota-reset-status"]')?.textContent.includes('Nothing to reset')`);
    expect(await page.evaluate(`document.querySelector('${codex} .reserve').textContent`)).toContain('1 banked reset');
    // Spending the last credit keeps its result visible after the reserve disappears.
    await page.click(`${claude} [data-testid="quota-use-reset"]`);
    await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')?.textContent.includes('Claude')`);
    await page.click('[data-testid="confirm-ok"]');
    await page.waitFor(`document.querySelector('${claude} [data-testid="quota-reset-status"]')?.textContent.includes('Reset applied')`);
    expect(await page.evaluate(`document.querySelector('${claude} [data-testid="quota-use-reset"]')`)).toBeNull();
    // A phone closes each confirmation with an asynchronous history.back().
    // Let that pop land before the next scenario navigates to another core.
    await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]') && (history.state?.boiteDepth ?? 0) === ${historyDepth}`);
    if (width === 390) {
      // Leave the mobile detail before a desktop resize unmounts it and pops its entry.
      await page.click('[data-testid="mobile-settings-back"]');
      await page.waitFor(`document.querySelector('[data-testid="mobile-settings-home"]') && (history.state?.boiteDepth ?? 0) < ${historyDepth}`);
    }
    expect(page.errors()).toEqual([]);
  }, 60_000);
}

test('the same popup shares priorities across the app, tray and phone through the owning core', async () => {
  const harness = await startTestCore({ settings: { browserOrigins: [origin] } });
  const client = await harness.connect();
  let tray: BrowserPage | undefined;
  try {
    const names = ['Personal', 'Work', 'Research', 'Studio', 'Travel'];
    const accounts = [];
    for (const label of names) accounts.push(await client.call('accounts.add', { providerId: 'echo', label, useDefaultLocation: false }));
    const rows: AccountQuota[] = accounts.map((account, index) => ({
      accountId: account.id, providerId: index === 1 ? 'codex' : 'claude', providerName: index === 1 ? 'Codex' : 'Claude', label: 'Cached profile',
      enabled: true, status: 'ready', checkedAt: Date.now(), error: null,
      windows: [{ id: 'week', label: 'Weekly', usedPercent: index === 1 ? 100 : 25, resetsAt: new Date(2026, 9, 7, 20, 55).getTime() }],
      ...(index === 1 ? { credits: { kind: 'balance' as const, enabled: true, remaining: 42.5, limit: null, unlimited: false } } : {}),
    }));
    // Keep real accounts, persistence, events and transports. Only provider readings are scripted, without live logins.
    harness.core.quotas.list = async () => structuredClone(rows);
    const endpoint = `core=${encodeURIComponent(harness.url)}&token=${encodeURIComponent(harness.token)}`;
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    await page.navigate(`${origin}/?${endpoint}`);
    await page.click('[data-testid="confirm-ok"]');
    await page.click('[data-testid="nav-limits"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="quota-provider"]').length === 5`);
    tray = await BrowserPage.launch({ url: `${origin}/?fake=1&view=quotas`, windowSize: { width: 380, height: 460 } });
    // A native tray reads the shell's endpoint. Give this separate browser profile that same established endpoint.
    await tray.waitFor(`document.querySelector('[data-testid="quota-popup"]')`);
    await tray.evaluate(`localStorage.setItem('boite.core', ${JSON.stringify(JSON.stringify({ url: harness.url, token: harness.token }))})`);
    await tray.navigate(`${origin}/?view=quotas`);
    await tray.waitFor(`document.querySelectorAll('[data-testid="quota-provider"]').length === 5`);
    const orderedNames = (browser: BrowserPage) => browser.evaluate<string[]>(`[...document.querySelectorAll('[data-testid="quota-provider"] .name')].map(row => row.textContent)`);
    expect(await orderedNames(page)).toEqual(names);
    expect(await orderedNames(tray)).toEqual(names);
    const panel = '[data-testid="quota-panel"]';
    for (const browser of [page, tray]) {
      const heading = (await browser.text(`${panel} h2`)).trim();
      if (browser === tray) expect(heading).toBe('Account limits');
      else expect(heading).toMatch(/^Account limits for /);
      expect(await browser.evaluate(`document.querySelectorAll('[data-testid="quota-machine-scope"]').length`)).toBe(browser === tray ? 0 : 1);
      expect(await browser.evaluate(`document.querySelector('${panel} footer button').textContent`)).toBe('Limits page');
      expect(await browser.evaluate(`document.querySelector('[data-account-id="${accounts[1]!.id}"] .paid').textContent`)).toContain('Using credits');
      expect(await browser.evaluate(`getComputedStyle(document.querySelector('[data-account-id="${accounts[0]!.id}"] .track')).height`)).toBe('7px');
      expect(await browser.evaluate(`document.querySelector('[data-account-id="${accounts[0]!.id}"] .reset').textContent`)).toMatch(/^Wednesday /);
      expect(await browser.evaluate(`document.querySelectorAll('${panel} .reorder').length`)).toBe(0);
      // Five profiles fit in the usual popup without scrolling to reach the last one.
      expect(await browser.evaluate(`(() => {
        const body = document.querySelector('${panel} .body').getBoundingClientRect();
        const last = [...document.querySelectorAll('[data-testid="quota-provider"]')].at(-1).getBoundingClientRect();
        return last.bottom <= body.bottom;
      })()`)).toBe(true);
    }
    await capture('limits-popup-desktop.png');
    await tray.screenshot(join(process.env.BOITE_CAPTURE_DIR ?? join(import.meta.dir, '.artifacts'), 'limits-popup-tray.png'));

    const bounds = await page.evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(() => {
      const handle = document.querySelector('[data-account-id="${accounts[1]!.id}"] [data-testid="quota-reorder"]').getBoundingClientRect();
      const target = document.querySelector('[data-account-id="${accounts[0]!.id}"]').getBoundingClientRect();
      return { from: { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, to: { x: handle.x + handle.width / 2, y: target.top + 16 } };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bounds.from });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds.from, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...bounds.to, buttons: 1 });
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[1]!.id}'`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bounds.to, button: 'left', clickCount: 1 });
    await tray.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[1]!.id}'`);
    expect((await client.call('settings.get', {})).quotaOrder?.[0]).toBe(accounts[1]!.id);
    // Releasing a row drag must not also expand its details.
    expect(await page.evaluate(`document.querySelectorAll('${panel} .details').length`)).toBe(0);
    // A click with a small pointer wobble still opens the quota details without changing priorities.
    await page.waitFor(`document.querySelector('[data-account-id="${accounts[1]!.id}"] .summary')?.disabled === false`);
    const clickPoint = await page.evaluate<{ x: number; y: number }>(`(() => {
      const name = document.querySelector('[data-account-id="${accounts[1]!.id}"] .name').getBoundingClientRect();
      return { x: name.x + name.width / 2, y: name.y + name.height / 2 };
    })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...clickPoint, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clickPoint.x + 2, y: clickPoint.y + 2, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clickPoint.x + 2, y: clickPoint.y + 2, button: 'left', clickCount: 1 });
    await page.waitFor(`document.querySelector('[data-account-id="${accounts[1]!.id}"] .details')`);
    expect((await client.call('settings.get', {})).quotaOrder?.[0]).toBe(accounts[1]!.id);
    await page.click(`[data-account-id="${accounts[1]!.id}"] .summary`);
    await capture('limits-popup-dragged.png');

    // Keyboard reversal in the tray reaches the app too.
    const handle = `[data-account-id="${accounts[1]!.id}"] [data-testid="quota-reorder"]`;
    await tray.evaluate(`document.querySelector('${handle}').focus()`);
    await tray.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await tray.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[0]!.id}'`);
    expect(await orderedNames(tray)).toEqual(names);
    await page.click('[data-testid="nav-limits"]');
    await page.click('[data-testid="nav-limits"]');
    expect(await orderedNames(page)).toEqual(names);

    // A constrained viewport still allows dragging from the bottom to the top while scrolling.
    await tray.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 300, deviceScaleFactor: 1, mobile: false });
    await tray.waitFor(`document.querySelector('${panel} .body').clientHeight < 220`);
    // The settings event can update the order before the previous save enables the rows.
    await tray.waitFor(`document.querySelector('[data-account-id="${accounts[4]!.id}"] [data-testid="quota-reorder"]')?.disabled === false`);
    const scrollDrag = await tray.evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(async () => {
      const body = document.querySelector('${panel} .body');
      body.scrollTop = body.scrollHeight;
      // Let the viewport resize and scroll reach paint before CDP hit-tests the pointer.
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const grip = document.querySelector('[data-account-id="${accounts[4]!.id}"] [data-testid="quota-reorder"]').getBoundingClientRect();
      const box = body.getBoundingClientRect();
      return { from: { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, to: { x: grip.x + grip.width / 2, y: box.top + 12 } };
    })()`);
    expect(await tray.evaluate(`document.elementFromPoint(${scrollDrag.from.x}, ${scrollDrag.from.y})?.closest('[data-testid="quota-reorder"]')?.closest('[data-account-id]')?.dataset.accountId === '${accounts[4]!.id}'`)).toBe(true);
    await tray.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...scrollDrag.from });
    await tray.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...scrollDrag.from, button: 'left', buttons: 1, clickCount: 1 });
    await tray.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...scrollDrag.to, buttons: 1 });
    await tray.waitFor(`document.querySelector('${panel} .body').scrollTop === 0 && document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[4]!.id}'`);
    await tray.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...scrollDrag.to, button: 'left', clickCount: 1 });
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[4]!.id}'`);
    expect((await client.call('settings.get', {})).quotaOrder?.[0]).toBe(accounts[4]!.id);
    await client.call('settings.set', { quotaOrder: accounts.map((account) => account.id) });
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[0]!.id}'`);

    await tray.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 460, deviceScaleFactor: 1, mobile: false });
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    // Reload gives the phone's real sheet placement rather than retaining the desktop floating action.
    await page.navigate(`${origin}/?${endpoint}`);
    await page.click('[data-testid="sidebar-toggle"]');
    await page.click('[data-testid="nav-limits"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="quota-provider"]').length === 5`);
    await page.waitFor(`document.querySelector('[data-account-id="${accounts[1]!.id}"] [data-testid="quota-reorder"]')?.disabled === false`);
    const touch = await page.evaluate<{ from: { x: number; y: number }; to: { x: number; y: number } }>(`(async () => {
      // The phone sheet animates and its ResizeObserver places it after the rows appear.
      await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const grip = document.querySelector('[data-account-id="${accounts[1]!.id}"] .name').getBoundingClientRect();
      const first = document.querySelector('[data-testid="quota-provider"]').getBoundingClientRect();
      return { from: { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 }, to: { x: grip.x + grip.width / 2, y: first.y + 16 } };
    })()`);
    expect(await page.evaluate(`document.elementFromPoint(${touch.from.x}, ${touch.from.y})?.closest('[data-testid="quota-reorder"]')?.closest('[data-account-id]')?.dataset.accountId === '${accounts[1]!.id}'`)).toBe(true);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...touch.from, id: 1 }] });
    await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touch.to, id: 1 }] });
    await page.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[1]!.id}'`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await tray.waitFor(`document.querySelector('[data-testid="quota-provider"]')?.dataset.accountId === '${accounts[1]!.id}'`);
    expect(await page.evaluate(`document.querySelectorAll('${panel} .details').length`)).toBe(0);
    await capture('limits-popup-phone.png');
    expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('${panel} .body').scrollWidth <= document.querySelector('${panel} .body').clientWidth`)).toBe(true);
    await client.call('accounts.rename', { accountId: accounts[1]!.id, label: 'Work subscription' });
    for (const browser of [page, tray]) await browser.waitFor(`document.querySelector('[data-testid="quota-provider"] .name')?.textContent === 'Work subscription'`);
    // A fresh webview starts from the saved core order.
    await tray.navigate(`${origin}/?view=quotas`);
    await tray.waitFor(`document.querySelector('[data-testid="quota-provider"] .name')?.textContent === 'Work subscription'`);
    expect((await client.call('settings.get', {})).quotaOrder?.[0]).toBe(accounts[1]!.id);

    // Swiping a meter on a short phone viewport scrolls without rearranging or expanding its account.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 340, deviceScaleFactor: 1, mobile: true });
    await page.waitFor(`document.querySelector('${panel} .body').scrollHeight > document.querySelector('${panel} .body').clientHeight`);
    const swipe = await page.evaluate<{ x: number; y: number }>(`(async () => {
      const body = document.querySelector('${panel} .body');
      body.scrollTop = 0;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const meter = document.querySelector('[data-account-id="${accounts[0]!.id}"] .track').getBoundingClientRect();
      return { x: meter.x + meter.width / 2, y: meter.y + meter.height / 2 };
    })()`);
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...swipe, id: 1 }] });
    for (let step = 1; step <= 6; step++) {
      await page.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.x, y: swipe.y - step * 12, id: 1 }] });
    }
    await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitFor(`document.querySelector('${panel} .body').scrollTop > 0`);
    expect((await client.call('settings.get', {})).quotaOrder?.[0]).toBe(accounts[1]!.id);
    expect(await page.evaluate(`document.querySelectorAll('${panel} .details').length`)).toBe(0);
  } finally { await tray?.close(); client.close(); await harness.stop(); }
}, 60_000);
