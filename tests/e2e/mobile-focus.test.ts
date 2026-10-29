import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const typing = `!!document.activeElement?.matches('textarea, input:not([type=radio]):not([type=checkbox]), [contenteditable=true]')`;

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

async function tap(selector: string) {
  const point = await page.evaluate<{ x: number; y: number }>(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollIntoView({ block: 'nearest' });
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await page.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function shiftTab() {
  for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', modifiers: 8, windowsVirtualKeyCode: 9 });
}

async function ask() {
  await page.evaluate(`(() => { const store = __boiteTest.workspace.active;
    return store.client.call('questions.ask', { threadId: store.openThread.id, text: 'Which checks should run?', options: ['Unit tests', 'Browser tests'] });
  })()`);
  await page.waitFor(`document.querySelector('[data-testid=activity-question]:not([hidden]) [data-testid=question-option]')`);
}

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
}, 60_000);
afterAll(async () => { try { await page?.close(); } finally { await server?.close(); } }, 60_000);

test('desktop still opens its composer ready to type', async () => {
  expect(await page.evaluate(`document.activeElement?.matches('[data-testid=composer-input]')`)).toBe(true);
  await ask();
  await capture('keyboard-choices-desktop.png');
});

test('phone choices, folder browsing and overlay dismissal never focus a text field automatically', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
  expect(await page.evaluate(`matchMedia('(pointer: coarse)').matches`)).toBe(true);
  expect(await page.evaluate(typing)).toBe(false);
  await page.evaluate(`window.typingFocus = []; document.addEventListener('focusin', event => {
    if (event.target.matches('textarea, input:not([type=radio]):not([type=checkbox])')) window.typingFocus.push(event.target.dataset.testid ?? event.target.tagName);
  });`);
  await ask();
  expect(await page.evaluate(typing)).toBe(false);
  await capture('keyboard-choices-phone.png');
  await tap('[data-testid=activity-question]:not([hidden]) [data-testid=question-option]');
  await page.waitFor(`!document.querySelector('[data-testid=composer-send]').disabled`);
  await tap('[data-testid=composer-send]');
  await page.waitFor(`!document.querySelector('[data-testid=activity-question]')`);
  expect(await page.evaluate(typing)).toBe(false);
  await page.evaluate('__boiteTest.workspace.active.projectPickerOpen = true');
  await page.waitFor(`document.querySelector('[data-testid=project-path]')?.value === '/workspace'`);
  expect(await page.evaluate(`document.activeElement?.matches('[data-testid=project-picker]')`)).toBe(true);
  await tap('[data-testid=project-cancel]');
  await page.waitFor(`!document.querySelector('[data-testid=project-picker]')`);
  expect(await page.evaluate('window.typingFocus')).toEqual([]);

  // A tap to write is intentional. Dismissing a later dialog must not summon it again.
  await tap('[data-testid=composer-input]');
  expect(await page.evaluate(typing)).toBe(true);
  await page.evaluate(`import('/src/lib/confirm.svelte.ts').then(({ confirm }) => { void confirm.ask({ title: 'Continue?', confirmLabel: 'Continue', cancelLabel: 'Cancel' }); })`);
  await page.waitFor(`document.activeElement?.matches('[data-confirm]')`);
  await tap('[data-confirm]');
  await page.waitFor(`!document.querySelector('[data-testid=confirm-dialog]')`);
  expect(await page.evaluate(typing)).toBe(false);
  expect(await page.evaluate('document.activeElement === document.body')).toBe(false);

  await page.evaluate(`import('/src/lib/confirm.svelte.ts').then(({ confirm }) => { void confirm.ask({ title: 'Remove project?', confirmLabel: 'Remove', cancelLabel: 'Cancel', requiredText: 'project' }); })`);
  await page.waitFor(`document.activeElement?.matches('[data-testid=confirm-dialog]')`);
  await shiftTab();
  expect(await page.evaluate(`document.activeElement?.matches('[data-testid=confirm-cancel]')`)).toBe(true);
  await tap('[data-testid=confirm-cancel]');
  await page.waitFor(`!document.querySelector('[data-testid=confirm-dialog]')`);

  await page.evaluate(`__boiteTest.workspace.active.showSettings('diagnostics')`);
  await page.waitFor(`document.querySelector('[data-testid=diagnostics-report]:not(:disabled)')`);
  await tap('[data-testid=diagnostics-report]');
  await page.waitFor(`document.activeElement?.matches('[data-testid=diagnostics-report-dialog]')`);
  await shiftTab();
  expect(await page.evaluate(`document.activeElement?.matches('[data-testid=diagnostics-report-dialog] .actions .ghost')`)).toBe(true);
  await tap('[data-testid=diagnostics-report-dialog] .actions .ghost');
  // Settle both phone history entries before the next test changes viewport and navigates.
  await page.evaluate('__boiteTest.workspace.active.showSettings()');
  await page.waitFor(`!document.querySelector('[data-testid=diagnostics-report-dialog]') && !history.state?.boiteOverlay`);
  expect(page.errors()).toEqual([]);
}, 30_000);

test('landscape touch devices browse models without opening the keyboard', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
  // Resizing removes mobile settings and pops its history entry before this reload.
  await page.waitFor(`!document.querySelector('.mobile-settings') && !history.state?.boiteOverlay`);
  await page.navigate(url);
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
  expect(await page.evaluate(typing)).toBe(false);
  await tap('[data-testid=composer-picker]');
  await page.waitFor(`document.querySelector('[data-testid=picker-search]')`);
  expect(await page.evaluate(typing)).toBe(false);
  await capture('keyboard-models-landscape.png');
  await tap('[data-testid=picker-search]');
  expect(await page.evaluate(typing)).toBe(true);
  await page.send('Input.insertText', { text: 'Echo' });
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker-menu]')?.dataset.mobileSheet === 'true'`);
  expect(await page.evaluate(`document.activeElement?.matches('[data-testid=picker-search]')`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid=picker-search]').value`)).toBe('Echo');
  await page.send('Input.insertText', { text: ' model' });
  expect(await page.evaluate(`document.querySelector('[data-testid=picker-search]').value`)).toBe('Echo model');
  expect(page.errors()).toEqual([]);
}, 30_000);
