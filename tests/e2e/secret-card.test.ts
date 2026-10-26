import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'secret-card');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const SECRET = 'sk-live-4f9b2c71e0d84a6b';

let page: BrowserPage;
let server: { close(): Promise<void> };
let port: number;
beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
  await page.waitFor(`window.__boiteTest?.workspace.active?.connection === 'ready'`);
}, 60000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(ARTIFACTS, name));
}

const PENDING = '[data-testid="secret-card"][data-state="pending"]';

/** Shows the card at both widths: it stays inside a phone's screen and the page never scrolls sideways. */
async function bothWidths(selector: string, name: string) {
  await page.evaluate(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`);
  await capture(`${name}-desktop.png`);
  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('${selector}')?.getBoundingClientRect().width > 0`);
  await page.evaluate(`document.querySelector('${selector}').scrollIntoView({ block: 'center' })`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await page.evaluate(`(() => { const box = document.querySelector('${selector}').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`)).toBe(true);
  await capture(`${name}-phone.png`);
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.waitFor(`document.querySelector('${selector}')?.getBoundingClientRect().width > 0`);
}

/** The request belongs to the composer, so reading old output cannot move it away. */
async function staysDocked() {
  const before = await page.evaluate<number>(`document.querySelector('${PENDING}').getBoundingClientRect().top`);
  await page.evaluate(`(() => {
    const timeline = document.querySelector('[data-testid="timeline"]');
    timeline.scrollTop = 0;
    timeline.dispatchEvent(new Event('scroll'));
  })()`);
  await page.evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  const geometry = await page.evaluate<{ top: number; bottom: number; inputTop: number }>(`(() => {
    const box = document.querySelector('${PENDING}').getBoundingClientRect();
    const input = document.querySelector('[data-testid="composer-input"]').getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, inputTop: input.top };
  })()`);
  expect(Math.abs(geometry.top - before)).toBeLessThan(2);
  expect(geometry.top).toBeGreaterThan(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.inputTop);
}

/** Asks from the agent's side; the outcome lands in `window.__secretOutcome`. */
function ask(params: Record<string, unknown>) {
  return page.evaluate(`(() => {
    const store = window.__boiteTest.workspace.active;
    window.__secretOutcome = null;
    store.client.call('secrets.ask', { threadId: window.__secretThread, name: 'OPENAI_API_KEY', reason: 'To embed the docs for search, the indexer calls the OpenAI API.', placeholder: 'sk-...', ...${JSON.stringify(params)} })
      .then(outcome => { window.__secretOutcome = outcome; });
    return null;
  })()`);
}

test('an agent asks for a key: the card takes it masked, keeps it for the project, folds to one line and Settings lists it', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    window.__secretThread = thread.id;
    await window.__boiteTest.workspace.select(store, thread.id);
    await store.client.call('turns.start', { threadId: thread.id, prompt: 'index the docs' });
    return null;
  })()`);
  await page.waitFor(`window.__boiteTest.workspace.active.openThread?.turns.at(-1)?.status === 'done'`);

  // Open, with the box unticked: a one-off copy unless the user keeps it.
  await ask({});
  await page.waitFor(`document.querySelector('${PENDING} [data-testid="secret-keep"]')?.checked === false`);
  expect(await page.evaluate(`document.querySelector('${PENDING}')?.closest('[data-testid="thread-activity"]') != null`)).toBe(true);
  expect((await page.text('[data-testid="activity-question-toggle"]')).trim()).toBe('OPENAI_API_KEY');
  await bothWidths(PENDING, 'open-unchecked');
  await staysDocked();
  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await staysDocked();
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

  // Typed through the real keyboard path: masked on screen, and no character reaches the composer.
  await page.evaluate(`document.querySelector('${PENDING} [data-testid="secret-field"]').focus()`);
  await page.send('Input.insertText', { text: SECRET.slice(0, 14) });
  await page.waitFor(`document.querySelector('${PENDING} [data-testid="secret-field"]').value.length === 14`);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('${PENDING} [data-testid="secret-field"]')).webkitTextSecurity`)).toBe('disc');
  await bothWidths(PENDING, 'typing');
  await page.evaluate(`document.querySelector('${PENDING} [data-testid="secret-field"]').focus()`);
  await page.send('Input.insertText', { text: SECRET.slice(14) });
  await page.click(`${PENDING} [data-testid="secret-keep"]`);
  await page.evaluate(`document.querySelector('${PENDING} [data-testid="secret-field"]').focus()`);
  expect(await page.evaluate(`document.querySelector('[data-testid="composer"]')?.textContent.includes('sk-live') ?? false`)).toBe(false);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', windowsVirtualKeyCode: 13 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });

  // Saved: one line in the timeline, and the agent gets a ref, never the value.
  const saved = '[data-testid="secret-card"][data-state="saved"][data-kept="true"]';
  await page.waitFor(`document.querySelector('${saved}') && window.__secretOutcome`);
  expect(await page.text(`${saved} [data-testid="secret-outcome"]`)).toBe('OPENAI_API_KEY saved and kept for this project');
  expect(await page.evaluate(`window.__secretOutcome.ref`)).toBe('secret:project/OPENAI_API_KEY');
  expect(await page.evaluate(`[document.body.innerHTML, JSON.stringify(window.__boiteTest.workspace.active.openThread), JSON.stringify(window.__boiteTest.workspace.active.composerStates), JSON.stringify({ ...localStorage })].some(text => text.includes('sk-live'))`)).toBe(false);
  await bothWidths(saved, 'saved');

  // Asked again to replace it: the card says so and starts ticked.
  await ask({ replace: true });
  await page.waitFor(`document.querySelector('${PENDING} [data-testid="secret-keep"]')?.checked === true`);
  expect(await page.text(`${PENDING} [data-testid="secret-replaces"]`)).toBe('Replaces the key kept for this project.');
  await bothWidths(PENDING, 'open-checked');
  await page.click(`${PENDING} [data-testid="secret-decline"]`);
  await page.waitFor(`document.querySelector('[data-testid="secret-card"][data-state="declined"]') && window.__secretOutcome?.outcome === 'declined'`);

  // Settings lists the kept key by name and date, under its project.
  await page.evaluate(`window.__boiteTest.workspace.active.showSettings('general', 'secrets')`);
  const key = '[data-testid="secrets-card"] [data-testid="secrets-key"][data-name="OPENAI_API_KEY"]';
  await page.waitFor(`document.querySelector('${key}')?.getBoundingClientRect().width > 0`);
  expect(await page.text('[data-testid="secrets-storage"]')).toBe('Stored in Windows (DPAPI)');
  await page.evaluate(`document.querySelector('[data-testid="secrets-card"]').scrollIntoView({ block: 'start' })`);
  await capture('settings-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('[data-testid="mobile-settings-detail"] ${key}')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('settings-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
}, 90_000);
