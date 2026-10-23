import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { startTestCore } from '../../packages/core/test/harness.ts';
import { BrowserEngines } from '../../packages/core/src/browser/engines.ts';
import { BrowserHost } from '../../packages/core/src/browser/host.ts';
import { findChromium } from '../../packages/core/src/browser/chromium.ts';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

test.skipIf(!findChromium().path)('a configured profile sends its User-Agent to a file page and its worker at process startup', async () => {
  const harness = await startTestCore();
  const engines = new BrowserEngines(harness.core, new BrowserHost(), findChromium, 'fixture', 'system:browser', () => {}, () => {},
    { prepare: () => harness.dataDir, lost: () => {} });
  let engine: Awaited<ReturnType<typeof engines.launch>> | undefined;
  let owner: Awaited<ReturnType<typeof harness.connect>> | undefined;
  try {
    owner = await harness.connect();
    await owner.call('settings.set', { browserProfiles: [{ id: 'p-file', name: 'File', userAgent: { mode: 'suffix', value: 'Bounty/1' } }] });
    engine = await engines.launch('p-file');
    const path = join(harness.dataDir, 'user-agent.html');
    writeFileSync(path, '<!doctype html><title>User-Agent fixture</title>');
    const { targetId } = await engine.cdp.send<{ targetId: string }>('Target.createTarget', { url: pathToFileURL(path).href });
    const { sessionId } = await engine.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    let loaded = false;
    for (let i = 0; i < 100; i++) {
      const state = await engine.cdp.send<{ result: { value?: boolean } }>('Runtime.evaluate', {
        expression: "location.protocol === 'file:' && document.readyState === 'complete'", returnByValue: true,
      }, sessionId).catch(() => null);
      if (state?.result.value) { loaded = true; break; }
      await Bun.sleep(50);
    }
    expect(loaded).toBe(true);
    // No page override: these values must come from the Chromium process flag.
    const { result } = await engine.cdp.send<{ result: { value: string[] } }>('Runtime.evaluate', {
      expression: `(async () => [navigator.userAgent, await new Promise(resolve => { const w = new Worker(URL.createObjectURL(new Blob(['postMessage(navigator.userAgent)']))); w.onmessage = e => { w.terminate(); resolve(e.data); }; })])()`,
      awaitPromise: true, returnByValue: true,
    }, sessionId);
    expect(result.value[0]).toMatch(/ Chrome\/.* Bounty\/1$/);
    expect(result.value[1]).toBe(result.value[0]);
  } finally {
    try { if (engine) await engines.shut(engine); }
    finally { owner?.close(); await harness.stop(); }
  }
}, 90_000);

test('profile User-Agent settings save, survive rename and clear on desktop and phone', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent` });
    await page.waitFor("document.querySelector('[data-testid=nav-settings]')", 40_000);
    await page.click('[data-testid=nav-settings]');
    await page.click('[data-testid=settings-tab-general]');
    const store = 'globalThis.__boiteTest.workspace.active';
    for (const [width, height, mobile] of [[1280, 900, false], [390, 844, true]] as const) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      if (mobile) await page.click('[data-testid=mobile-settings-browser-profiles]');
      await page.evaluate(`${store}.saveSettings({ browserProfiles: [{ id: 'p-research', name: 'Research' }] })`);
      await page.click('[data-testid=browser-user-agent-edit]');
      await page.type('[data-testid=browser-user-agent-value]', 'Bounty/1');
      await page.click('[data-testid=browser-user-agent-save]');
      await page.waitFor(`${store}.settings.browserProfiles[0].userAgent?.value === 'Bounty/1'`);
      await page.click('[data-testid=browser-profile-rename]');
      await page.type('[data-testid=browser-profile-rename-input]', 'Research renamed');
      await page.evaluate("document.querySelector('form.rename').requestSubmit(); true");
      await page.waitFor(`${store}.settings.browserProfiles[0].name === 'Research renamed'`);
      expect(await page.evaluate(`JSON.stringify(${store}.settings.browserProfiles[0].userAgent)`)).toBe(JSON.stringify({ mode: 'suffix', value: 'Bounty/1' }));
      await page.click('[data-testid=browser-user-agent-edit]');
      await page.click('[data-testid=browser-user-agent-mode]');
      await page.click('[data-value=replace]');
      await page.type('[data-testid=browser-user-agent-value]', 'Research/1');
      await page.evaluate("document.querySelector('[data-testid=browser-user-agent-form]').scrollIntoView({ block: 'center' }); true");
      await page.evaluate('document.fonts.ready');
      await page.settleAnimations();
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.screenshot(join(import.meta.dir, '.artifacts', mobile ? 'browser-user-agent-phone.png' : 'browser-user-agent-desktop.png'));
      await page.click('[data-testid=browser-user-agent-save]');
      await page.waitFor(`${store}.settings.browserProfiles[0].userAgent?.mode === 'replace'`);
      await page.click('[data-testid=browser-user-agent-edit]');
      await page.type('[data-testid=browser-user-agent-value]', '');
      await page.click('[data-testid=browser-user-agent-save]');
      await page.waitFor(`${store}.settings.browserProfiles[0].userAgent === undefined`);
      await page.click('[data-testid=browser-profile-delete]');
      await page.waitFor("document.querySelector('[data-testid=browser-profile-error]')?.textContent.includes('desktop app')");
      expect(await page.evaluate(`${store}.settings.browserProfiles[0].name`)).toBe('Research renamed');
      await page.evaluate("document.querySelector('[data-testid=browser-profile-error]').scrollIntoView({ block: 'center' }); true");
      await page.settleAnimations();
      await page.screenshot(join(import.meta.dir, '.artifacts', mobile ? 'browser-profile-delete-phone.png' : 'browser-profile-delete-desktop.png'));
    }
  } finally { await page?.close(); await server.close(); }
}, 90_000);
