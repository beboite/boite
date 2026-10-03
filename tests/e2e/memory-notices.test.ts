import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

let server: { close(): Promise<void> };
let page: BrowserPage;
const id = (name: string) => `[data-testid="${name}"]`;

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
  await page.waitFor(`document.querySelector('[data-thread-id="t-trace"]')`);
  await page.click('[data-thread-id="t-trace"]');
  await page.waitFor('globalThis.__boiteTest.workspace.active.openThread?.id === "t-trace"');
}, 90000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15000);

async function capture(name: string) {
  await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
  await page.screenshot(join(import.meta.dir, '.artifacts', `memory-${name}.png`));
}

test('memory stops stay between tools, fold together and link to a working switch on desktop and phone', async () => {
  await page.evaluate("__boiteTest.setTheme('dark')");
  await page.evaluate(`(async () => {
    const { setLocaleSetting } = await import('/src/lib/i18n.svelte.ts');
    await setLocaleSetting('fr');
    const store = __boiteTest.workspace.active;
    const thread = store.openThread;
    const message = thread.messages.at(-1);
    const at = Date.now();
    thread.messages = [thread.messages[0], message];
    message.parts = [
      { type: 'text', text: 'Checking the build before retrying.' },
      { type: 'tool', toolId: 'first', name: 'Bash', input: { command: 'cargo check' }, output: 'Checked', status: 'done', startedAt: at - 10000 },
      { type: 'tool', toolId: 'build', name: 'Bash', input: { command: 'cargo build' }, output: 'Process stopped', status: 'error', startedAt: at - 5000 },
    ];
    thread.memoryEvents = ['uvx.exe', 'bunx.exe', 'uv.exe', 'node.exe'].map((exe, index) => ({
      threadId: thread.id, kind: 'killed', reason: 'machine', limitBytes: 3072 * 1048576,
      exe, bytes: [456 * 1024, 284 * 1048576, 116 * 1048576, 66 * 1048576][index],
      state: 'critical', at: at + index * 3000, anchor: { messageId: message.id, partIndex: 3 },
    }));
    message.parts.push(
      { type: 'text', text: 'Retrying the build with two workers.' },
      { type: 'tool', toolId: 'retry', name: 'Bash', input: { command: 'cargo build -j 2' }, output: 'Build completed', status: 'done', startedAt: at + 20000 },
    );
  })()`);
  await page.waitFor(`document.querySelector('${id('memory-row')}')?.textContent.includes('4 processus')`);
  expect(await page.evaluate(`document.querySelectorAll('${id('memory-row')}').length`)).toBe(1);
  expect(await page.evaluate(`(() => { const t = document.querySelector('${id('timeline')}').textContent; return t.indexOf('cargo build') < t.indexOf('4 processus') && t.indexOf('4 processus') < t.indexOf('Retrying'); })()`)).toBe(true);
  for (const width of [1280, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
    await page.evaluate(`document.querySelector('${id('memory-row')}').scrollIntoView({ block: 'center' })`);
    await capture(width < 720 ? 'phone' : 'desktop');
    const row = await page.evaluate<{ height: number; fits: boolean }>(`(() => { const e = document.querySelector('${id('memory-row')}'); return { height: e.getBoundingClientRect().height, fits: e.scrollWidth <= e.clientWidth }; })()`);
    expect(row.height).toBeLessThan(width < 720 ? 250 : 180);
    expect(row.fits).toBe(true);
    expect(await page.evaluate(`document.querySelector('${id('memory-row')} details').open`)).toBe(false);
    await page.click(`${id('memory-row')} summary`);
    await page.waitFor(`document.querySelector('${id('memory-row')} details').open`);
    expect(await page.evaluate(`document.querySelectorAll('${id('memory-row')} .process').length`)).toBe(4);
    await capture(width < 720 ? 'phone-expanded' : 'desktop-expanded');
    await page.click(`${id('memory-row')} summary`);
    await page.click(`${id('memory-row')} .configure`);
    await page.waitFor(`document.querySelector('${id('setting-memory-protection')}')`);
    await capture(width < 720 ? 'settings-phone' : 'settings-desktop');
    await page.click(id('setting-memory-protection'));
    await page.waitFor(`__boiteTest.workspace.active.settings.memoryProtection === false && __boiteTest.workspace.active.memory.limits.budgetMb === 0`);
    expect(await page.evaluate(`document.querySelector('${id('memory-cap')}').disabled`)).toBe(true);
    expect(await page.text(id('memory-status'))).toContain('Protection mémoire désactivée');
    await capture(width < 720 ? 'settings-phone-off' : 'settings-desktop-off');
    await page.click(id('setting-memory-protection'));
    await page.waitFor(`__boiteTest.workspace.active.settings.memoryProtection === true && __boiteTest.workspace.active.memory.limits.budgetMb > 0`);
    await page.evaluate('__boiteTest.workspace.active.showChat()');
    await page.waitFor(`document.querySelector('${id('memory-row')}')`);
  }
  expect(page.errors()).toEqual([]);
}, 60000);

test('a single stopped process fits both themes and narrow screens, including long executable names', async () => {
  await page.evaluate(`(async () => {
    const { setLocaleSetting } = await import('/src/lib/i18n.svelte.ts');
    await setLocaleSetting('en');
    const thread = __boiteTest.workspace.active.openThread;
    thread.memoryEvents = [{
      threadId: thread.id, kind: 'killed', reason: 'machine', limitBytes: 3277 * 1048576,
      exe: 'C:\\\\tools\\\\python.exe', bytes: 334 * 1048576, state: 'critical', at: Date.now(),
      anchor: { messageId: thread.messages.at(-1).id, partIndex: 3 },
    }];
  })()`);
  await page.waitFor(`document.querySelector('${id('memory-row')} .process')?.textContent === 'python.exe'`);
  for (const width of [1280, 390]) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 });
    for (const theme of ['dark', 'light']) {
      await page.evaluate(`__boiteTest.setTheme('${theme}')`);
      await page.evaluate(`document.querySelector('${id('memory-row')}').scrollIntoView({ block: 'center' })`);
      await capture(`single-${width < 720 ? 'phone' : 'desktop'}-${theme}`);
      expect(await page.text(`${id('memory-row')} .size`)).toBe('334 MB');
      expect(await page.evaluate(`(() => {
        const row = document.querySelector('${id('memory-row')}');
        const r = row.getBoundingClientRect();
        const button = row.querySelector('.configure').getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && row.scrollWidth <= row.clientWidth
          && button.right <= r.right && button.bottom <= r.bottom;
      })()`)).toBe(true);
    }
  }
  await page.evaluate(`__boiteTest.workspace.active.openThread.memoryEvents[0].exe = '/bin/' + 'long-build-worker-'.repeat(12) + '.exe'`);
  await page.waitFor(`document.querySelector('${id('memory-row')} .process')?.textContent.startsWith('long-build-worker-')`);
  expect(await page.evaluate(`(() => {
    const row = document.querySelector('${id('memory-row')}');
    const process = row.querySelector('.process');
    return row.scrollWidth <= row.clientWidth && process.scrollWidth <= process.clientWidth;
  })()`)).toBe(true);
  expect(page.errors()).toEqual([]);
}, 30000);
