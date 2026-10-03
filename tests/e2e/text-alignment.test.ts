import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

let page: BrowserPage;
let server: { close(): Promise<void> };
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
  await page.waitFor(`document.querySelector('[data-testid="composer-effort"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); });

/** Measure the cap-height centre, rather than the font's invisible ascent/descent box. */
async function offsets(pairs: [string, string][]) {
  return page.evaluate<{ label: string; offset: number; inkFits: boolean }[]>(`(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    return ${JSON.stringify(pairs)}.map(([control, label]) => {
      const parent = document.querySelector(control), el = document.querySelector(label);
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node;
      while (node = walker.nextNode()) if (node.textContent.trim()) break;
      const range = document.createRange(); range.selectNodeContents(node || el);
      const text = range.getBoundingClientRect(), box = parent.getBoundingClientRect(), style = getComputedStyle(node.parentElement);
      ctx.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
      const cap = ctx.measureText('H'), ink = ctx.measureText('Égj'), inkBox = node.parentElement.getBoundingClientRect();
      const baseline = text.top + (text.height - cap.fontBoundingBoxAscent - cap.fontBoundingBoxDescent) / 2 + cap.fontBoundingBoxAscent;
      return {
        label, offset: baseline - cap.actualBoundingBoxAscent / 2 - box.top - box.height / 2,
        inkFits: baseline - ink.actualBoundingBoxAscent >= inkBox.top - 0.1 && baseline + ink.actualBoundingBoxDescent <= inkBox.bottom + 0.1,
      };
    });
  })()`);
}

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
    for (const result of await offsets(pairs)) {
      expect(Math.abs(result.offset), `${font}: ${result.label}`).toBeLessThanOrEqual(0.8);
      expect(result.inkFits, `${font}: ${result.label} accents/descenders`).toBe(true);
    }
    await page.evaluate(`__boiteTest.workspace.active.showSettings('accounts')`);
    await page.waitFor(`document.querySelector('[data-testid="settings"] h1.ui-label-box .ui-label')`);
    await page.waitFor(`document.querySelector('[data-testid="subscription-proxy-settings"] h2 .info-tip')`);
    for (const result of await offsets([
      ['[data-testid="settings"] h1 .info-tip', '[data-testid="settings"] h1 .ui-label'],
      ['[data-testid="subscription-proxy-settings"] h2 .info-tip', '[data-testid="subscription-proxy-settings"] h2 .ui-label'],
      ['[data-testid="subscription-proxy-settings"] form .info-tip', '[data-testid="subscription-proxy-settings"] form .ui-label-box .ui-label'],
      ['[data-testid="subscription-proxy-save"]', '[data-testid="subscription-proxy-save"] .ui-label'],
    ])) {
      expect(Math.abs(result.offset), `${font}: heading information icon`).toBeLessThanOrEqual(0.8);
    }
    await page.evaluate(`__boiteTest.workspace.active.showChat()`);
  }
  await page.click('[data-testid="composer-mode"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-mode"]')?.getAttribute('aria-expanded') === 'true'`);
  for (const result of await offsets([['.menu .item', '.menu .item .label > span:last-child']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', windowsVirtualKeyCode: 27 });
  await page.evaluate(`__boiteTest.workspace.active.showSettings('general')`);
  await page.waitFor(`document.querySelector('[data-testid="settings-tab-general"]')`);
  for (const result of await offsets([['[data-testid="settings-tab-general"]', '[data-testid="settings-tab-general"] > span']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.evaluate(`__boiteTest.workspace.active.showSettings('task-manager')`);
  await page.waitFor(`document.querySelector('[data-testid="task-manager"] .live .ui-label')`);
  for (const result of await offsets([['[data-testid="task-manager"] dt', '[data-testid="task-manager"] dt .ui-label']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  // A new text span must not inherit the status dot's width or background.
  expect(await page.evaluate(`(() => {
    const label = document.querySelector('[data-testid="task-manager"] .live .ui-label');
    const style = getComputedStyle(label), box = label.getBoundingClientRect();
    return box.width > 40 && box.height < 30 && style.backgroundColor === 'rgba(0, 0, 0, 0)';
  })()`)).toBe(true);
  await page.evaluate(`__boiteTest.workspace.active.showChat()`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid="composer-options"]').getBoundingClientRect().width > 0`);
  for (const result of await offsets([pairs[1]!])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  await page.click('[data-testid="composer-options"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-options-sheet"]')`);
  for (const result of await offsets([['.choices.permissions label', '.choices.permissions label > span']])) expect(Math.abs(result.offset)).toBeLessThanOrEqual(0.8);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(page.errors()).toEqual([]);
}, 30_000);
