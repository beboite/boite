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
