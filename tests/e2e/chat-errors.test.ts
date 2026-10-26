import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
const diagnostic = 'Claude returned a server error. API Error: 503 no available subscription for this model; connect an account or wait for its quota reset. This is a server-side issue, usually temporary - try again in a moment. If it persists, check https://status.claude.com.';

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 1000 } });
  await page.waitFor('globalThis.__boiteTest?.workspace.active.openThread');
  await page.evaluate(`(() => {
    __boiteTest.setTheme('dark');
    const thread = __boiteTest.workspace.active.openThread;
    const base = thread.turns[0];
    const at = Date.now() - 3600000;
    const labels = ['Pull request update, #695: merge conflict', 'Background work finished', 'Resumed after an error', 'Resumed after an error'];
    thread.title = 'Review the pull request';
    thread.status = 'error'; thread.progress = null; thread.background = []; thread.memoryEvents = [];
    thread.turns = labels.map((_, i) => ({ ...base, id: 'error-turn-' + i, status: 'error', queuedAt: at + i * 600000,
      startedAt: at + i * 600000, finishedAt: at + i * 600000 + 411000, usage: null, error: ${JSON.stringify(diagnostic)} }));
    thread.messages = labels.flatMap((label, i) => {
      const turn = thread.turns[i];
      const common = { threadId: thread.id, turnId: turn.id, state: 'complete', createdAt: turn.startedAt };
      return [
        { ...common, id: 'system-' + i, role: 'system', parts: [{ type: 'text', text: label }] },
        { ...common, id: 'error-' + i, role: 'assistant', parts: [{ type: 'error', message: ${JSON.stringify(diagnostic)} }] }
      ];
    });
  })()`);
  await page.waitFor(`document.querySelector('[data-testid="failed-attempts"]')`);
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30000);

async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir, '.artifacts', `chat-errors-${name}.png`));
}

test('failed automatic turns share one folded group and retain every wake-up, timestamp and diagnostic', async () => {
  if (process.env.BOITE_CAPTURE_BEFORE === '1') await capture('before');
  for (const width of [1280, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 720 });
    await page.evaluate(`document.querySelector('[data-testid="timeline"]').scrollTop = 0`);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="failed-attempts"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="error-part"]').length`)).toBe(1);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="error-diagnostic"]').length`)).toBe(0);
    expect(await page.evaluate(`document.querySelector('[data-testid="failed-attempts-toggle"]').textContent`)).toContain('4 failed attempts');
    expect(await page.evaluate(`document.querySelector('[data-testid="error-title"]')?.textContent`)).toBe('No subscription available');
    expect(await page.evaluate(`document.querySelector('[data-testid="error-description"]')?.textContent`)).toBe('Connect an account or wait for its quota to reset.');
    expect(await page.evaluate(`document.querySelector('[data-testid="failed-attempts-history"]').open`)).toBe(false);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="turn-finished-at"]')).every(node => node.textContent.startsWith('failed '))`)).toBe(true);
    const name = width < 720 ? 'phone' : 'desktop';
    await capture(name);
    const toggleTop = await page.evaluate<number>(`document.querySelector('[data-testid="failed-attempts-toggle"]').getBoundingClientRect().top`);
    await page.click('[data-testid="failed-attempts-toggle"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="error-diagnostic"]').length === 4`);
    await page.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    expect(await page.evaluate<number>(`document.querySelector('[data-testid="failed-attempts-toggle"]').getBoundingClientRect().top`)).toBeCloseTo(toggleTop, 0);
    expect(await page.evaluate(`document.querySelectorAll('[data-testid="failed-attempt-entry"]').length`)).toBe(8);
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="error-diagnostic"]')).map(node => node.textContent)`)).toEqual(Array(4).fill(diagnostic));
    expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="error-part"]')).every(node => {
      const rect = node.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth && node.scrollWidth <= node.clientWidth;
    })`)).toBe(true);
    await capture(`${name}-expanded`);
    await page.click('[data-testid="failed-attempts-toggle"]');
    await page.waitFor(`document.querySelectorAll('[data-testid="failed-attempt-entry"]').length === 0`);
    await page.waitFor(`document.querySelector('[data-testid="jump-to-latest"]') === null`);
  }
  // Finding a wake-up opens the folded history and targets that original message.
  await page.evaluate(`__boiteTest.workspace.active.findOpen = true; __boiteTest.workspace.active.findRequest += 1`);
  await page.waitFor(`document.querySelector('[data-testid="find-input"]')`);
  await page.type('[data-testid="find-input"]', 'Background work finished');
  await page.waitFor(`(() => {
    const view = document.querySelector('[data-testid="timeline"]')?.getBoundingClientRect();
    const entry = document.querySelector('[data-mid="failure:system-1"]');
    if (!view || !entry) return false;
    const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT);
    const query = 'background work finished';
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const at = (node.nodeValue ?? '').toLowerCase().indexOf(query);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + query.length);
      const rect = range.getBoundingClientRect();
      return rect.top >= view.top && rect.bottom <= view.bottom;
    }
    return false;
  })()`);
  expect(await page.evaluate(`document.querySelector('[data-testid="failed-attempts-history"]').open`)).toBe(true);
  await page.click('[data-testid="find-close"]');
  await page.click('[data-testid="failed-attempts-toggle"]');
  // An unfamiliar error remains literal and complete, including long unbroken paths and HTML-like diagnostics.
  const unknown = 'Build failed: <script>not executable</script>\n' + 'x'.repeat(1000);
  await page.evaluate(`__boiteTest.workspace.active.openThread.messages.at(-1).parts[0].message = ${JSON.stringify(unknown)}`);
  await page.waitFor(`document.querySelector('[data-testid="error-title"]')?.textContent === "The agent couldn't continue"`);
  await page.click('[data-testid="failed-attempts-toggle"]');
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="error-diagnostic"]')).at(-1).textContent`)).toBe(unknown);
  expect(await page.evaluate(`document.querySelector('[data-testid="error-part"] script') === null`)).toBe(true);
  expect(await page.evaluate(`document.querySelector('[data-testid="error-part"]').scrollWidth <= document.querySelector('[data-testid="error-part"]').clientWidth`)).toBe(true);
  // Codex's own wording for an upstream rate limit is neither a missing subscription nor an outage.
  const limited = 'exceeded retry limit, last status: 429 Too Many Requests';
  await page.evaluate(`__boiteTest.workspace.active.openThread.messages.at(-1).parts[0].message = ${JSON.stringify(limited)}`);
  await page.waitFor(`document.querySelector('[data-testid="error-title"]')?.textContent === 'Rate limit reached'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="error-part"] .code')?.textContent`)).toBe('429');
  await capture('rate-limit-phone');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await capture('rate-limit-desktop');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 1000, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`__boiteTest.workspace.active.openThread.messages.at(-1).parts[0].message = 'HTTP 502 upstream unavailable'`);
  await page.waitFor(`document.querySelector('[data-testid="error-title"]')?.textContent === 'The provider is unavailable'`);
  await page.evaluate(`__boiteTest.setLocaleSetting('fr')`);
  await page.waitFor(`document.querySelector('[data-testid="error-title"]')?.textContent === 'Le fournisseur est indisponible'`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="error-diagnostic"]')).at(-1).textContent`)).toBe('HTTP 502 upstream unavailable');
  expect(await page.evaluate(`document.querySelector('[data-testid="turn-finished-at"]').textContent`)).toMatch(/^échec à /);
  await page.click('[data-testid="failed-attempts-toggle"]');
  expect(await page.evaluate(`document.querySelector('[data-testid="failed-attempts-toggle"]').textContent`)).toContain('4 tentatives en échec');
  await page.evaluate(`__boiteTest.setTheme('light'); document.querySelector('[data-testid="timeline"]').scrollTop = 0`);
  await capture('phone-light-fr');
}, 30000);
