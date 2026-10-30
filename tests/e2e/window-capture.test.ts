import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'window-capture');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const STORE = 'window.__boiteTest.workspace.active';

let page: BrowserPage;
let server: { close(): Promise<void> };
let url = '';
beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&windows=1`;
  page = await BrowserPage.launch({ url, experiments: [] });
  await page.waitFor(`${STORE}?.connection === 'ready'`);
}, 60000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(ARTIFACTS, name));
}

async function openTrace(viewport: typeof DESKTOP) {
  await page.send('Emulation.setDeviceMetricsOverride', viewport);
  await page.navigate(url);
  await page.waitFor(`${STORE}?.connection === 'ready'`);
  await page.evaluate(`window.__boiteTest.workspace.select(${STORE}, 't-trace')`);
}

const visible = (selector: string) => `(() => { const node = document.querySelector('${selector}'); const box = node?.getBoundingClientRect(); return !!box && box.width > 0 && box.height > 0; })()`;
const reveal = (selector: string) => page.evaluate(`document.querySelector('${selector}')?.scrollIntoView({ block: 'center' })`);

for (const [label, viewport] of [['desktop', DESKTOP], ['phone', PHONE]] as const) {
  test(`the timeline shows the capture and consent cards, and the panel the watched window (${label})`, async () => {
    await openTrace(viewport);
    // The demo's agent watches Unity: the Window tab comes forward, covered until Show.
    await page.waitFor(visible('[data-testid="window-cover"]'), 15000);
    await capture(`panel-cover-${label}.png`);
    await page.click('[data-testid="window-show"]');
    await page.waitFor(`document.querySelector('[data-testid="window-frame"]')?.complete === true`, 10000);
    await capture(`panel-frame-${label}.png`);
    await page.click('[data-testid="window-hide"]');
    if (label === 'phone') await page.evaluate(`history.back()`);

    await page.waitFor(`document.querySelector('[data-testid="window-consent"][data-state="pending"]')`, 10000);
    await reveal('[data-testid="window-consent"][data-state="pending"]');
    await page.waitFor(visible('[data-testid="window-consent"][data-state="pending"]'));
    await capture(`consent-waiting-${label}.png`);
    await page.click('[data-testid="window-consent"][data-state="pending"] [data-testid="window-consent-once"]');
    await page.waitFor(`![...document.querySelectorAll('[data-testid="window-consent"]')].some(card => card.dataset.state === 'pending')`);
    await capture(`consent-answered-${label}.png`);
    expect(await page.evaluate(`[...document.querySelectorAll('[data-testid="window-consent-verdict"]')].map(node => node.textContent)`)).toContain('Allowed once: blender.exe');

    await reveal('[data-testid="window-capture"][data-kind="clip"]');
    await page.waitFor(visible('[data-testid="window-capture"][data-kind="clip"]'));
    await capture(`capture-card-${label}.png`);
  }, 90_000);

  test(`Settings lists the allowed windows, confirms a removal and edits the exclusions (${label})`, async () => {
    await openTrace(viewport);
    await page.evaluate(`${STORE}.showSettings('general', 'windows')`);
    await page.waitFor(`document.querySelector('[data-testid="window-allowlist-project"]')?.textContent.includes('Unity.exe')`, 10000);
    await reveal('#settings-windows');
    await capture(`allowed-windows-${label}.png`);
    await page.click('[data-testid="window-allowlist-remove"]');
    await page.waitFor(visible('[data-testid="confirm-dialog"]'));
    expect(await page.evaluate(`document.querySelector('[data-testid="confirm-dialog"]').textContent`)).toContain('Stop allowing Unity.exe?');
    await capture(`allowed-windows-confirm-${label}.png`);
    await page.click('[data-testid="confirm-cancel"]');

    await page.evaluate(`${STORE}.saveSettings({ windowCaptureExclusions: ['obs64.exe', 'C:\\\\Games\\\\Secret\\\\secret.exe'] })`);
    await page.waitFor(`document.querySelectorAll('[data-testid="window-exclusion"]').length === 2`);
    await reveal('#settings-window-exclusions');
    await capture(`exclusions-${label}.png`);
  }, 90_000);

  test(`a request to read an app's controls says so on its card, and the read goes on once allowed (${label})`, async () => {
    await openTrace(viewport);
    await page.evaluate(`void ${STORE}.client.call('windows.read', { threadId: 't-trace', target: { process: 'blender' } }).then(read => { window.__guideRead = read; })`);
    const card = `[...document.querySelectorAll('[data-testid="window-consent"][data-state="pending"]')].find(node => node.textContent.includes('wants to read blender.exe'))`;
    await page.waitFor(`!!${card}`, 10000);
    await page.evaluate(`${card}.scrollIntoView({ block: 'center' })`);
    expect(await page.evaluate(`${card}.textContent`)).toContain('The names of its buttons and menus, to show you where to click');
    expect(await page.evaluate(`${card}.textContent`)).toContain('The read waits until');
    await capture(`consent-read-${label}.png`);
    await page.evaluate(`${card}.querySelector('[data-testid="window-consent-once"]').click()`);
    await page.waitFor(`window.__guideRead?.windowId === '198722'`, 10000);
    expect(await page.evaluate(`window.__guideRead.controls.map(control => control.name)`)).toContain('Render');
  }, 90_000);
}
