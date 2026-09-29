import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;

beforeAll(async () => {
  port = await freePort();
  server = await startUi(port);
}, 60_000);
afterAll(async () => { await server?.close(); });

for (const width of [1280, 390]) {
  test(`deleting a conversation at ${width}px asks first and removes it from the archive too`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width, height: 900 } });
    try {
      await page.waitFor(`globalThis.__boiteTest?.workspace.active.openThread && document.querySelector('[data-testid=thread-header]')`);
      const id = await page.evaluate<string>('globalThis.__boiteTest.workspace.active.openThread.id');
      const openMenu = async () => {
        if (width < 720) await page.click('[data-testid=thread-menu-trigger]');
        else await page.click(`[data-testid=thread-row][data-thread-id="${id}"] ~ [data-testid=thread-menu]`);
        await page.waitFor(`document.querySelector('[role=menu]:not(.closing)')`);
      };
      const chooseDelete = async () => {
        const hasDelete = await page.evaluate<boolean>(`Array.from(document.querySelectorAll('[role=menu]:not(.closing) [role=menuitem]')).some(b => b.textContent.trim() === 'Delete')`);
        expect(hasDelete).toBe(true);
        await page.evaluate(`Array.from(document.querySelectorAll('[role=menu]:not(.closing) [role=menuitem]')).find(b => b.textContent.trim() === 'Delete').click()`);
        await page.waitFor(`document.querySelector('[data-testid=confirm-dialog]:not(.closing)')`);
      };
      await openMenu();
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-menu-${width}.png`));
      await chooseDelete();
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-confirm-${width}.png`));
      expect(await page.evaluate<string>(`document.querySelector('[data-testid=confirm-dialog]').textContent`)).toContain('cannot be undone');
      await page.click('[data-testid=confirm-cancel]');
      expect(await page.evaluate<boolean>(`globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(id)})`)).toBe(true);
      await openMenu();
      await chooseDelete();
      await page.click('[data-testid=confirm-ok]');
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(id)})`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.list', { includeArchived: true }).then(rows => rows.some(t => t.id === ${JSON.stringify(id)}))`)).toBe(false);
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      if (width < 720) {
        await page.click('[data-testid=mobile-settings]');
        await page.waitFor(`document.querySelector('[data-testid=mobile-settings-archived]')`);
        await page.click('[data-testid=mobile-settings-archived]');
      } else {
        await page.click('[data-testid=nav-settings]');
        await page.waitFor(`document.querySelector('[data-testid=settings-tab-general]')`);
        await page.click('[data-testid=settings-tab-general]');
        await page.waitFor(`document.querySelector('[data-testid=archived-show]')`);
        await page.click('[data-testid=archived-show]');
      }
      await page.waitFor(`document.querySelector('[data-testid=archived-delete]')`);
      const archivedId = await page.evaluate<string>(`document.querySelector('[data-testid=archived-delete]').closest('li').dataset.threadId`);
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-archive-${width}.png`));
      await page.click('[data-testid=archived-delete]');
      await page.waitFor(`document.querySelector('[data-testid=confirm-dialog]:not(.closing)')`);
      await page.click('[data-testid=confirm-cancel]');
      expect(await page.evaluate(`document.querySelector('[data-testid=archived-list] [data-thread-id="${archivedId}"]') !== null`)).toBe(true);
      await page.click('[data-testid=archived-delete]');
      await page.waitFor(`document.querySelector('[data-testid=confirm-dialog]:not(.closing)')`);
      await page.click('[data-testid=confirm-ok]');
      await page.waitFor(`!document.querySelector('[data-testid=archived-list] [data-thread-id="${archivedId}"]')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.list', { includeArchived: true }).then(rows => rows.some(t => t.id === ${JSON.stringify(archivedId)}))`)).toBe(false);
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
}
