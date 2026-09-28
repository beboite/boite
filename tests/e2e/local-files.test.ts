import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

test('local launch links and file actions use the owning desktop, with browser and phone fallbacks', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`, experiments: ['chat-artifacts'], windowSize: { width: 1300, height: 850 } });
    await page.waitFor('document.querySelector("[data-thread-id=t-trace]")');
    await page.click('[data-thread-id=t-trace]');
    await page.evaluate(`(async () => {
      const { workspace } = await import('/src/lib/workspace.svelte.ts');
      const store = workspace.active;
      const thread = store.openThread;
      await store.client.call('files.write', { threadId: thread.id, path: 'game.exe', text: 'Inert game fixture' });
      thread.messages.at(-1).parts = [{ type: 'text', text: 'The game is ready.\\n\\n[Launch game](game.exe) · [Instructions](README.md)' }];
      window.__fileOpens = [];
      window.__TAURI_INTERNALS__ = { invoke: async (command, args) => { if (command === 'open_local_file') window.__fileOpens.push(args); } };
      store.localCore = true;
    })()`);
    await page.waitFor('document.querySelector("a[data-file-path=\\"game.exe\\"]")');
    expect(await page.evaluate('window.__fileOpens.length')).toBe(0);
    await page.click('a[data-file-path="game.exe"]');
    await page.waitFor('window.__fileOpens.length === 1');
    expect(await page.evaluate('document.querySelector("[data-testid=chat-file]")')).toBeNull();
    expect(await page.evaluate('window.__fileOpens[0].path')).toBe('game.exe');
    await page.evaluate('Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'local-file-launch-desktop.png'));

    await page.click('a[data-file-path="README.md"]');
    await page.waitFor('document.querySelector("[data-testid=artifact-open]")');
    await page.click('[data-testid=artifact-open]');
    await page.waitFor('window.__fileOpens.length === 2');
    expect(await page.evaluate('window.__fileOpens[1].path')).toBe('README.md');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'local-file-open-desktop.png'));

    // A remote core must never hand its paths to this computer's opener.
    await page.evaluate(`(async () => { const { workspace } = await import('/src/lib/workspace.svelte.ts'); workspace.active.localCore = false; })()`);
    await page.click('a[data-file-path="game.exe"]');
    await page.waitFor('document.querySelector("[data-testid=artifact-download]")?.download === "game.exe"');
    expect(await page.evaluate('document.querySelector("[data-testid=artifact-open]")')).toBeNull();
    expect(await page.evaluate('window.__fileOpens.length')).toBe(2);
    // The browser/phone keeps the same download path, with no native opener.
    await page.evaluate('delete window.__TAURI_INTERNALS__');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await page.evaluate('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'local-file-phone.png'));
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  } finally { await page?.close(); await server.close(); }
}, 90_000);
