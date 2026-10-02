import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

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
    await capture(`quota-${view}-partial.png`);
    expect(await filter('claude')).toBe('saturate(1)');
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
    expect(await page.evaluate(`document.querySelector('[data-testid="usage-limit-provider"][data-account-id="a-codex"] strong').textContent`)).toBe('Codex');
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
  await page.waitFor(`document.querySelector('[data-testid="quota-refresh"]')?.getAttribute('aria-busy') === 'false' && document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name')?.textContent === 'Codex'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="quota-provider"][data-account-id="a-codex"] .name').textContent`)).toBe('Codex');
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
