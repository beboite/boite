import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';
import { labelOffsets } from './lib/text-metrics';

let page: BrowserPage;
let server: { close(): Promise<void> };
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
  await page.waitFor(`document.querySelector('[data-testid="composer-effort"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); });

test('text and icons share a vertical centre across reading fonts, menus and phone controls', async () => {
  const pairs: [string, string][] = [
    ['[data-testid="header-project"]', '[data-testid="header-project"] > span:last-child'],
    ['[data-testid="composer-picker"]', '[data-testid="composer-picker"] .label'],
    ['[data-testid="composer-effort"]', '[data-testid="composer-effort"]'],
    ['[data-testid="composer-mode"]', '[data-testid="composer-mode"]'],
    ['[data-testid="view-projects"]', '[data-testid="view-projects"]'],
  ];
  for (const font of ['inter', 'geist', 'plex', 'atkinson', 'figtree', 'source', 'dm', 'system']) {
    await page.evaluate(`(async () => {
      document.documentElement.dataset.font = '${font}';
      const style = getComputedStyle(document.body);
      await document.fonts.load('500 13px ' + style.fontFamily);
      await document.fonts.load('600 14px ' + style.fontFamily);
      await document.fonts.ready;
    })()`);
    for (const result of await labelOffsets(page, pairs)) {
      expect(Math.abs(result.offset), `${font}: ${result.label}`).toBeLessThanOrEqual(0.8);
      expect(result.inkFits, `${font}: ${result.label} accents/descenders`).toBe(true);
    }
    await page.evaluate(`__boiteTest.workspace.active.showSettings('accounts')`);
    await page.waitFor(`document.querySelector('[data-testid="settings"] h1.ui-label-box .ui-label')`);
    await page.waitFor(`document.querySelector('[data-testid="subscription-proxy-settings"] h2 .info-tip')`);
    for (const result of await labelOffsets(page, [
      ['[data-testid="settings"] h1 .info-tip', '[data-testid="settings"] h1 .ui-label'],
      ['[data-testid="subscription-proxy-settings"] h2 .info-tip', '[data-testid="subscription-proxy-settings"] h2 .ui-label'],
      ['[data-testid="subscription-proxy-settings"] form .info-tip', '[data-testid="subscription-proxy-settings"] form .ui-label-box .ui-label'],
      ['[data-testid="subscription-proxy-save"]', '[data-testid="subscription-proxy-save"] .ui-label'],
    ])) {
      expect(Math.abs(result.offset), `${font}: heading information icon`).toBeLessThanOrEqual(0.8);
    }
    await page.evaluate(`__boiteTest.workspace.active.showSettings('machines')`);
    await page.waitFor(`document.querySelector('[data-testid="harness-updates-card"] h4 .info-tip')`);
    for (const result of await labelOffsets(page, [
      ['#updates-heading svg', '#updates-heading .ui-label'],
      ['#connections-heading svg', '#connections-heading .ui-label'],
      ['[data-testid="harness-updates-card"] h4 .info-tip', '[data-testid="harness-updates-card"] h4 .ui-label'],
      ['[data-testid="harness-updates-check"]', '[data-testid="harness-updates-check"] .ui-label'],
    ])) expect(Math.abs(result.offset), `${font}: machine updates`).toBeLessThanOrEqual(0.8);
    await page.evaluate(`__boiteTest.workspace.active.showSettings('voice')`);
    await page.waitFor(`document.querySelector('[data-testid="voice-models"] [data-testid^="voice-model-download-"] .ui-label')`);
    for (const result of await labelOffsets(page, [
      ['[data-testid="voice-models"] h2 .info-tip', '[data-testid="voice-models"] h2 .ui-label'],
      ['[data-testid="voice-models"] [data-testid^="voice-model-download-"]', '[data-testid="voice-models"] [data-testid^="voice-model-download-"] .ui-label'],
    ])) expect(Math.abs(result.offset), `${font}: voice model choices`).toBeLessThanOrEqual(0.8);
    await page.evaluate(`__boiteTest.workspace.active.showChat()`);
  }
  await page.click('[data-testid="composer-mode"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-mode"]')?.getAttribute('aria-expanded') === 'true'`);
  for (const result of await labelOffsets(page, [['.menu .item', '.menu .item .label > span:last-child']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await page.evaluate(`__boiteTest.workspace.active.showSettings('general')`);
  await page.waitFor(`document.querySelector('[data-testid="settings-tab-general"]')`);
  for (const result of await labelOffsets(page, [['[data-testid="settings-tab-general"]', '[data-testid="settings-tab-general"] > span']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.evaluate(`__boiteTest.workspace.active.showSettings('task-manager')`);
  await page.waitFor(`document.querySelector('[data-testid="task-manager"] .live .ui-label')`);
  for (const result of await labelOffsets(page, [['[data-testid="task-manager"] dt', '[data-testid="task-manager"] dt .ui-label']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  // A new text span must not inherit the status dot's width or background.
  expect(await page.evaluate(`(() => {
    const label = document.querySelector('[data-testid="task-manager"] .live .ui-label');
    const style = getComputedStyle(label), box = label.getBoundingClientRect();
    return box.width > 40 && box.height < 30 && style.backgroundColor === 'rgba(0, 0, 0, 0)';
  })()`)).toBe(true);
  await page.evaluate(`__boiteTest.workspace.active.showChat()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid="composer-options"]').getBoundingClientRect().width > 0`);
  for (const result of await labelOffsets(page, [pairs[1]!])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.click('[data-testid="composer-options"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-options-sheet"]')`);
  for (const result of await labelOffsets(page, [['.choices.permissions label', '.choices.permissions label > span']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 30_000);
