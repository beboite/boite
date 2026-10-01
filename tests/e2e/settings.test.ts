import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';
// Vite belongs to the UI workspace, not the repository root.
let server: { close(): Promise<void> };
let uiUrl: string;
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;
async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }
beforeAll(async () => {
  // The fake client is deliberately absent from production bundles.
  const port = await freePort();
  server = await startDevUi(port);
  uiUrl = `http://127.0.0.1:${port}`;
  page = await BrowserPage.launch({ url: `${uiUrl}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('model picker account tooltips keep emails private on desktop and phone', async () => {
  await page.navigate(`${uiUrl}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('${id('composer-picker')}')`);
  for (const [width, height, mobile] of [[1400, 1000, false], [390, 844, true]] as const) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    await page.click(id('composer-picker'));
    await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"] [data-provider="claude"]')`);
    await page.click('[data-testid="composer-picker-menu"] [data-provider="claude"]');
    await page.waitFor(`document.querySelector('[data-instance="claude::a-claude-main"]')`);
    expect(await page.evaluate(`document.querySelector('[data-instance="claude::a-claude-main"]').title`)).toBe('Default login');
    expect(await page.evaluate(`document.querySelector('[data-testid="composer-picker-menu"]').textContent.includes('you@example.com')`)).toBe(false);
    const point = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[data-instance="claude::a-claude-main"]').getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await capture(mobile ? 'model-account-private-phone.png' : 'model-account-private-desktop.png');
    await page.click(id('composer-picker'));
  }
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
}, 30_000);

test('provider settings show login controls, and quota monitoring lives on the Limits page', async () => {
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  await page.waitFor(`document.querySelectorAll('${id('provider-settings')}').length > 1`);
  // The page opens as a checklist: one row and at most one next step per provider.
  expect(await page.evaluate(`[...document.querySelectorAll('${id('provider-settings')}')].every(row => row.querySelectorAll('.act .primary').length <= 1)`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('account-row')}') === null`)).toBe(true);
  await capture('providers.png');
  // Accounts, the default model and the uninstall sit behind each row's chevron; limits do not.
  await page.evaluate(`document.querySelectorAll('${id('provider-details-toggle')}').forEach(button => button.click())`);
  await page.waitFor(`document.querySelector('${id('account-row')}')`);
  expect(await page.evaluate(`document.querySelector('${id('accounts-page')}').querySelector('${id('quota-monitor')}, [role=meter], progress') === null`)).toBe(true);
  await capture('providers-details.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 760, height: 900, deviceScaleFactor: 1, mobile: false });
  await capture('providers-details-narrow.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.querySelectorAll('${id('provider-details-toggle')}').forEach(button => button.click())`);
}, 30_000);

test('missing agents offer desktop setup while phone settings omit provider administration', async () => {
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => {
    workspace.active.providers = workspace.active.providers.map(p => ({...p, available: false, executable: null}));
    workspace.active.accounts = [];
  })`);
  await page.waitFor(`document.querySelector('[data-provider-id="claude"] a')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('accounts-page')} button:disabled').length`)).toBe(0);
  expect(await page.evaluate(`!!document.querySelector('[data-provider-id="antigravity"] [data-testid="install-start"]')`)).toBe(true);
  await capture('providers-missing-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid=accounts-page]') === null`)).toBe(true);
  await capture('providers-missing-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.click(id('providers-refresh'));
  await page.waitFor(`document.querySelector('[data-provider-id="claude"][data-step="sign-in"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
}, 30_000);

test('installing a missing agent goes on to its sign-in without a second click or a terminal', async () => {
  await page.navigate(`${uiUrl}/?fake=1&open=recent&uninstalled=1`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings')); await page.click(id('settings-tab-accounts'));
  const connect = '[data-provider-id="claude"] [data-testid="install-start"]';
  const downloading = '[data-provider-id="claude"][data-install="downloading"]';
  await page.waitFor(`document.querySelector('${connect}')`);
  await capture('connect-fresh.png');
  await page.click(connect);
  await page.waitFor(`document.querySelector('${downloading}')`);
  await page.click('[data-provider-id="claude"] [data-testid="install-cancel"]');
  await page.waitFor(`document.querySelector('${connect}')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid="account-login-row"]').length`)).toBe(0);
  await page.click(connect);
  await page.waitFor(`document.querySelector('${downloading}')`);
  await capture('connect-installing.png');
  await page.waitFor(`document.querySelector('[data-testid="account-login-row"] a')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="account-login-row"] a').href`)).toContain('https://');
  await capture('connect-login.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=mobile-settings-home]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="account-row"]') === null`)).toBe(true);
  await capture('connect-login-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.type('[data-testid="account-login-input"]', 'fake-code');
  await page.evaluate(`document.querySelector('[data-testid="account-login-input"]').closest('form').requestSubmit()`);
  await page.waitFor(`document.querySelector('[data-provider-id="claude"][data-step="ready"]')`);
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => workspace.active.reloadProviders())`);
  expect(await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => workspace.active.accountsOf('claude').map(({label,status}) => ({label,status})))`)).toEqual([{ label: 'Claude', status: 'ok' }]);
  await page.click('[data-provider-id="claude"] [data-testid="provider-details-toggle"]');
  await capture('connect-single-account.png');
}, 30_000);

test('Grain is visible above solid and acrylic surfaces and the settings fit a phone', async () => {
  await page.click(id('settings-tab-experiments')); await page.click(id('experiment-theme-grain'));
  await page.click(id('settings-tab-appearance')); await page.click(id('theme-grain'));
  await page.click(id('settings-back'));
  await page.waitFor(`document.documentElement.dataset.theme === 'grain'`);
  await capture('grain-after.png');
  await page.evaluate(`document.documentElement.dataset.glass = 'acrylic'`);
  await capture('grain-acrylic.png');
  expect(await page.evaluate(`getComputedStyle(document.body, '::after').pointerEvents`)).toBe('none');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('${id('nav-settings')}').click()`);
  await page.click(id('settings-tab-appearance'));
  await capture('providers-phone.png');
  expect(await page.evaluate(`document.querySelector('${id('settings')}').getBoundingClientRect().width`)).toBeLessThanOrEqual(390);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
}, 30_000);

test('the Limits page turns the monitoring of each account on and off', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  await page.click(id('nav-settings')); await page.click(id('settings-tab-limits'));
  await page.waitFor(`document.querySelector('${id('limits-tracked')} ${id('quota-monitor')}')`);
  const opencode = `${id('limits-tracked')} ${id('quota-monitor')}[data-account-id="a-opencode"]`;
  await page.waitFor(`document.querySelector('${opencode}')`);
  expect(await page.evaluate(`document.querySelector('${opencode}').checked`)).toBe(true);
  // The Antigravity CLI's own reading starts off, and the only switch that turns it on is here.
  expect(await page.evaluate(`document.querySelector('${id('limits-tracked')} ${id('quota-monitor')}[data-account-id="quota:antigravity-cli"]').checked`)).toBe(false);
  await page.click(opencode);
  await page.waitFor(`!document.querySelector('${opencode}').checked && !document.querySelector('${id('usage-limits')} [data-provider="opencode"]')`);
  await capture('limits-tracked.png');
  await page.click(opencode);
  await page.waitFor(`document.querySelector('${id('usage-limits')} [data-provider="opencode"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('${id('limits-tracked')}').scrollIntoView()`);
  await capture('limits-tracked-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
}, 30_000);

test('the experiment exposes only a bottom-left launcher for the dedicated Agents interface', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('${id('nav-settings')}')`);
  expect(await page.evaluate(`document.querySelector('${id('nav-agents')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('mobile-agents')}') === null`)).toBe(true);
  await capture('agents-launcher-disabled-desktop.png');
  await page.click(id('nav-settings')); await page.click(id('settings-tab-experiments'));
  await page.click(id('experiment-resident-agents'));
  await page.click(id('settings-back'));
  await page.waitFor(`document.querySelector('${id('nav-agents')}')`);
  expect(await page.evaluate(`!!document.querySelector('.foot ${id('nav-agents')}')`)).toBe(true);
  await capture('agents-launcher-enabled-desktop.png');
  await page.click(id('nav-agents'));
  await page.waitFor(`document.querySelector('${id('agents-page')}')`);
  // Switched off while it is open, the page closes with it.
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('resident-agents', false))`);
  await page.waitFor(`!document.querySelector('${id('agents-page')}') && document.querySelector('${id('nav-settings')}') && !document.querySelector('${id('nav-agents')}')`);
  // Switched on again, the chat stays where it is: nobody navigated to the page.
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('resident-agents', true))`);
  await page.waitFor(`document.querySelector('${id('nav-agents')}')`);
  expect(await page.evaluate(`document.querySelector('${id('agents-page')}') === null`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  expect(await page.evaluate(`document.querySelectorAll('${id('mobile-tabs')} > button').length`)).toBe(3);
  expect(await page.evaluate(`document.querySelector('${id('mobile-agents')}').closest('nav') === null`)).toBe(true);
  expect(await page.evaluate(`(e => { const r = e.getBoundingClientRect(); return r.left < 32 && r.bottom > innerHeight - 32; })(document.querySelector('${id('mobile-agents')}'))`)).toBe(true);
  await capture('agents-launcher-enabled-phone.png');
  await page.click(id('mobile-agents'));
  await page.waitFor(`document.querySelector('${id('agents-page')}')`);
  await page.evaluate(`import('/src/lib/experiments.ts').then(({ setExperiment }) => setExperiment('resident-agents', false))`);
  await page.waitFor(`!document.querySelector('${id('agents-page')}') && !document.querySelector('${id('mobile-agents')}')`);
  await capture('agents-launcher-disabled-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
}, 30_000);

test('the compact quota page shows limits and reset times', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 460, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent&view=quotas`);
  await page.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.waitFor(`document.querySelectorAll('${id('quota-provider')}').length >= 4 && document.querySelector('[role="meter"]')`);
  // The popup window is opaque and square: the page paints the canvas to every corner and rounds nothing.
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('quota-popup')}')).backgroundColor`)).not.toBe('rgba(0, 0, 0, 0)');
  expect(await page.evaluate(`getComputedStyle(document.body).clipPath`)).toBe('none');
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('quota-popup')}')).borderRadius`)).toBe('0px');
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('quota-popup')}')).borderTopWidth`)).toBe('1px');
  await capture('quota-popup.png');
  // Only signed-in providers the user reads: Antigravity's CLI source is off, echo and pi report nothing.
  const listed = await page.evaluate<string[]>(`Array.from(document.querySelectorAll('${id('quota-provider')}')).map(el => el.dataset.provider)`);
  expect(listed).toEqual(expect.arrayContaining(['claude', 'codex', 'grok', 'opencode']));
  for (const absent of ['antigravity', 'echo', 'pi']) expect(listed).not.toContain(absent);
  expect(await page.evaluate(`document.querySelector('${id('quota-popup')}').textContent`)).toContain('Resets');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  // Unfolded, an account lists each window with its own bar; there is nothing to set here.
  await page.click('[data-provider="claude"] .summary');
  await page.waitFor(`document.querySelectorAll('#usage-a-claude-main [role="meter"]').length === 3`);
  expect(await page.evaluate(`document.querySelector('${id('quota-popup')}').querySelector('input') === null`)).toBe(true);
  await capture('quota-popup-open.png');
  await page.click('[data-provider="claude"] .summary');
  await page.waitFor(`!document.querySelector('#usage-a-claude-main')`);
  expect(await page.evaluate(`document.querySelector('section').scrollWidth <= document.querySelector('section').clientWidth`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('section').scrollHeight <= document.querySelector('section').clientHeight`)).toBe(true);
  await page.evaluate(`document.documentElement.dataset.theme = 'light'`);
  await capture('quota-popup-light.png');
  await page.evaluate(`document.documentElement.dataset.theme = 'grain'`);
  await capture('quota-popup-grain.png');
  expect(await page.evaluate(`getComputedStyle(document.documentElement).backgroundColor`)).toBe('rgba(0, 0, 0, 0)');
  // Where Windows 11 draws the rounded frame, the page draws no border inside it.
  await page.navigate(`${uiUrl}/?fake=1&open=recent&view=quotas&frame=native`);
  await page.waitFor(`document.querySelector('${id('quota-popup')}')`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${id('quota-popup')}')).borderTopWidth`)).toBe('0px');
}, 30_000);

test('machines list each execution host and disconnect only the selected host', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.navigate(`${uiUrl}/?fake=1&open=recent&machines=1`);
  await page.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  await page.waitFor(`document.querySelectorAll('[data-machine-id="http://builder.test"] [data-testid="thread-row"]').length > 0`);
  await page.click(id('nav-settings'));
    await page.click(id('settings-tab-machines'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 2`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="machine-rename"]')).map(input => input.value)`)).toContain('Builder');
  await capture('machines.png');
  // Checking the option immediately copies settings and keeps following changes.
  expect(await page.evaluate(`document.querySelectorAll('${id('machine-sync')}').length`)).toBe(1);
  await page.evaluate(`(async () => {
    const w = globalThis.__boiteTest.workspace;
    await w.machines.find(machine => machine.id === 'http://builder.test').store.client.call('settings.set', { asyncQuestions: true });
    await w.active.client.call('settings.set', { asyncQuestions: false });
  })()`);
  await page.click(id('machine-sync'));
  await page.waitFor(`globalThis.__boiteTest.workspace.settingsSync.reports['http://builder.test'] && !globalThis.__boiteTest.workspace.settingsSync.busy['http://builder.test']`);
  expect(await page.evaluate(`globalThis.__boiteTest.workspace.machines.find(machine => machine.id === 'http://builder.test').store.settings.asyncQuestions`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('${id('machine-sync')}').closest('${id('machine-card')}').querySelector('${id('machine-rename')}').value`)).toBe('Builder');
  expect(await page.evaluate(`document.querySelector('${id('machine-sync-report')}') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('${id('machine-sync')}').checked`)).toBe(true);
  await capture('machines-sync.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // The phone layout draws the page anew; the checked state stays.
  await page.waitFor(`document.querySelector('${id('machine-sync')}')?.checked`);
  expect(await page.evaluate(`document.querySelector('${id('machine-sync-report')}') === null`)).toBe(true);
  await capture('machines-sync-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await page.click(id('machine-remove'));
  await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
  await page.click(id('confirm-ok'));
  await page.waitFor(`document.querySelectorAll('[data-testid="machine-card"]').length === 1`);
}, 30_000);

test('composer and buttons keep solid fallback fills without color-mix', async () => {
  await page.navigate(`${uiUrl}/?fake=1&open=recent`);
  await page.waitFor(`document.querySelector('${id('composer-picker')}')`);
  const opacity = await page.evaluate<number[][]>(`(async () => {
    const removed = [];
    const root = document.documentElement;
    const theme = root.dataset.theme, glass = root.dataset.glass;
    try {
      // Simulate unavailable feature branches while the browser still computes the default CSS rules.
      for (const sheet of document.styleSheets) {
        for (let index = sheet.cssRules.length - 1; index >= 0; index--) {
          const rule = sheet.cssRules[index];
          if (rule instanceof CSSSupportsRule && rule.conditionText.includes('color-mix')) {
            removed.push({ sheet, index, text: rule.cssText });
            sheet.deleteRule(index);
          }
        }
      }
      const context = new OffscreenCanvas(1, 1).getContext('2d');
      const result = [];
      for (const mode of ['dark', 'light', 'grain', 'glass']) {
        root.dataset.theme = mode === 'glass' ? 'dark' : mode;
        if (mode === 'glass') root.dataset.glass = 'acrylic'; else delete root.dataset.glass;
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})));
        result.push(['composer', 'composer-picker'].map(name => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = getComputedStyle(document.querySelector('[data-testid="' + name + '"]')).backgroundColor;
          context.fillRect(0, 0, 1, 1);
          return context.getImageData(0, 0, 1, 1).data[3];
        }));
      }
      return result;
    } finally {
      for (const item of removed.reverse()) item.sheet.insertRule(item.text, item.index);
      if (theme === undefined) delete root.dataset.theme; else root.dataset.theme = theme;
      if (glass === undefined) delete root.dataset.glass; else root.dataset.glass = glass;
    }
  })()`);
  expect(opacity).toEqual([[255, 255], [255, 255], [255, 255], [255, 255]]);
}, 30_000);
