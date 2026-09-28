import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { BrowserPage, freePort } from './lib/cdp';
import { removeDirectory } from './lib/cleanup';
import { startUi } from './lib/ui';

async function settle(page: BrowserPage) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
}
async function escape(page: BrowserPage) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

test('a blocked journal does not block startup or overwrite unread drafts', async () => {
  const port = await freePort();
  const server = await startUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
    await page.type('[data-testid=composer-input]', 'An older durable draft');
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.flushDrafts()')).toBe(true);
    await page.evaluate('Object.keys(localStorage).filter(k => k.startsWith("boite.unsent")).forEach(k => localStorage.removeItem(k))');
    const script = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: 'IDBFactory.prototype.open = function() { return {}; };' }) as { identifier: string };
    await page.reload();
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.click('[data-testid=thread-row]');
    const id = await page.evaluate<string>('globalThis.__boiteTest.workspace.active.openThread.id');
    await page.type('[data-testid=composer-input]', 'A reply during the storage failure');
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.flushDrafts()')).toBe(false);
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script.identifier });
    await page.reload();
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    expect(await page.evaluate('Array.from(document.querySelectorAll("[data-testid=draft-row]")).map(row => row.textContent).join(" ")')).toContain('An older durable draft');
    await page.click(`[data-testid=thread-row][data-thread-id="${id}"]`);
    await page.waitFor('document.querySelector("[data-testid=composer-input]")?.value === "A reply during the storage failure"');
  } finally { await page?.close(); await server.close(); }
}, 60_000);

test('drafts survive reload and composer menus stay above the chrome', async () => {
  const port = await freePort();
  const server = await startUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, windowSize: { width: 1100, height: 760 } });
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.type('[data-testid=composer-input]', 'A draft worth keeping');
    await settle(page);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'drafts-desktop.png'));
    const heights = await page.evaluate<{ draft: number; row: number }>(`({ draft: document.querySelector('[data-testid=draft-row]').getBoundingClientRect().height, row: document.querySelector('[data-testid=thread-row]').getBoundingClientRect().height })`);
    expect(heights.draft).toBeLessThanOrEqual(heights.row + 1);
    await page.send('Page.reload', {});
    await page.waitFor('document.querySelector("[data-testid=composer-input]")?.value === "A draft worth keeping"');
    await page.click('[data-testid=thread-row]');
    await page.waitFor('document.querySelector("[data-testid=timeline]")');
    expect(await page.evaluate('document.querySelector("[data-testid=draft-row]") !== null')).toBe(true);
    await page.type('[data-testid=composer-input]', 'Unsent reply');
    await page.send('Page.reload', {});
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.click('[data-testid=thread-row]');
    await page.waitFor('document.querySelector("[data-testid=composer-input]")?.value === "Unsent reply"');
    await page.click('[data-testid=composer-effort]');
    await page.waitFor('document.querySelector("[data-testid=composer-effort-menu]")');
    expect(await page.evaluate('document.querySelector("[data-testid=composer-effort-menu]").matches(":popover-open")')).toBe(true);
    await settle(page);
    expect(await page.evaluate(`(() => { const el = document.querySelector('[data-testid=composer-effort-menu]'); const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + 20, r.y + 20)) && r.left >= 0 && r.right <= innerWidth; })()`)).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'overlays-desktop.png'));
    await escape(page);
    await page.waitFor('!document.querySelector("[data-testid=composer-effort-menu]")');
    await page.click('[data-testid=composer-mode]');
    await page.waitFor('document.querySelector("[data-testid=composer-mode-menu]")?.matches(":popover-open")');
    await escape(page);
    await page.waitFor('!document.querySelector("[data-testid=composer-mode-menu]")');
    await page.type('[data-testid=composer-input]', '/');
    await page.waitFor('document.querySelector("[data-testid=slash-menu]")?.matches(":popover-open")');
    await settle(page);
    expect(await page.evaluate(`(() => { const r = document.querySelector('[data-testid=slash-menu]').getBoundingClientRect(); return r.top >= 44 && r.bottom <= innerHeight; })()`)).toBe(true);
    await escape(page);
    await page.type('[data-testid=composer-input]', 'Unsent reply');

    await page.click('[data-testid=panel-toggle]');
    await page.waitFor('document.querySelector("[data-testid=right-panel]")');
    expect(await page.evaluate('getComputedStyle(document.querySelector("[data-testid=right-panel]")).animationName')).toBe('rise');
    await settle(page);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'panels-desktop.png'));
    await page.click('[data-testid=panel-close]');
    expect(await page.evaluate('getComputedStyle(document.querySelector("[data-testid=right-panel]")).animationName')).toBe('rise-out');
    await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
    await page.click('[data-testid=terminal-toggle]');
    await page.waitFor('document.querySelector("[data-testid=terminal-drawer]")');
    await settle(page);
    await page.click('[data-testid=terminal-hide]');
    expect(await page.evaluate('getComputedStyle(document.querySelector("[data-testid=terminal-drawer]")).animationName')).toBe('rise-out');
    await page.waitFor('!document.querySelector("[data-testid=terminal-drawer]")');
    await page.evaluate('document.documentElement.dataset.motion = "reduced"');
    await page.click('[data-testid=panel-toggle]');
    await page.waitFor('document.querySelector("[data-testid=right-panel]")');
    expect(await page.evaluate('parseFloat(getComputedStyle(document.querySelector("[data-testid=right-panel]")).animationDuration)')).toBeLessThan(0.001);
    await page.click('[data-testid=panel-close]');
    await page.waitFor('!document.querySelector("[data-testid=right-panel]")');
    await page.evaluate('delete document.documentElement.dataset.motion');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await settle(page);
    await page.click('[data-testid=composer-options]');
    await page.waitFor('document.querySelector("[data-testid=composer-options-sheet]")?.dataset.mobileSheet === "true"');
    await settle(page);
    await page.screenshot(join(import.meta.dir, '.artifacts', 'overlays-phone.png'));
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await server.close(); }
}, 120_000);

test('unsent text survives the browser process being killed', async () => {
  const port = await freePort();
  const server = await startUi(port);
  const profile = mkdtempSync(join(tmpdir(), 'boite-e2e-draft-restart-'));
  const options = { url: `http://127.0.0.1:${port}/?fake=1`, userDataDir: profile };
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch(options);
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.type('[data-testid=composer-input]', 'Recover after a forced exit');
    await page.evaluate(`(() => { const data = new DataTransfer(); data.items.add(new File([new Uint8Array(4 * 1024 * 1024)], 'draft.bin', { type: 'application/octet-stream' })); document.querySelector('[data-testid=composer-input]').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true })); })()`);
    await page.waitFor('document.querySelector("[data-testid=composer-attachment]")');
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.flushDrafts()')).toBe(true);
    // close() kills the captured browser PID; no pagehide or unload callback saves the draft.
    await page.close();
    page = await BrowserPage.launch(options);
    await page.waitFor('document.querySelector("[data-testid=composer-input]")?.value === "Recover after a forced exit"');
    expect(await page.evaluate('document.querySelector("[data-testid=composer-attachment]")?.textContent.includes("draft.bin")')).toBe(true);
    await page.click('[data-testid=thread-row]');
    await page.waitFor('document.querySelector("[data-testid=timeline]")');
    const thread = await page.evaluate<string>('document.querySelector("[data-testid=thread-row]").closest("[data-thread-id]").dataset.threadId');
    await page.type('[data-testid=composer-input]', 'Recover this reply too');
    expect(await page.evaluate('globalThis.__boiteTest.workspace.active.flushDrafts()')).toBe(true);
    await page.close();
    page = await BrowserPage.launch(options);
    await page.waitFor('document.querySelector("[data-testid=composer-input]")');
    await page.click(`[data-testid=thread-row][data-thread-id="${thread}"]`);
    await page.waitFor('document.querySelector("[data-testid=composer-input]")?.value === "Recover this reply too"');
  } finally { await page?.close(); await server.close(); await removeDirectory(profile); }
}, 120_000);
