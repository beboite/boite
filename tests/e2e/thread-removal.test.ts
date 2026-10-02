import { mobileAction } from './lib/mobile.ts';
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
  test(`archived conversation titles and actions stay readable at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width, height: 900 } });
    try {
      await page.waitFor(`globalThis.__boiteTest?.workspace.active.openThread`);
      await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
      await page.evaluate(`(async () => {
        const store = globalThis.__boiteTest.workspace.active;
        const source = await store.client.call('threads.get', {threadId:'t-parser'});
        await store.client.call('threads.update', {threadId:'t-parser', title:'Restore a conversation with a readable title'});
        for (let i = 0; i < 6; i++) {
          const thread = await store.client.call('threads.create', {projectId:source.projectId, providerId:source.providerId, accountId:source.accountId, model:source.model, title:'Review the installation and background processes ' + (i + 1)});
          await store.client.call('threads.archive', {threadId:thread.id});
        }
      })()`);
      if (width < 720) {
        await mobileAction(page, 'mobile-settings');
        await page.waitFor(`document.querySelector('[data-testid=mobile-settings-archived]')`);
        await page.click('[data-testid=mobile-settings-archived]');
        await page.waitFor(`document.querySelectorAll('[data-testid=archived-list] li').length === 7`);
      } else {
        await page.waitFor(`document.querySelector('[data-testid=archived-drawer-toggle]')`);
        await page.click('[data-testid=archived-drawer-toggle]');
        await page.waitFor(`document.querySelectorAll('[data-testid=archived-drawer] li').length === 7`);
      }
      // A theme change can leave transitions pending inside closed disclosures.
      // Only wait for the archive surface whose layout this capture verifies.
      const archives = width < 720 ? '[data-testid=archived-list]' : '[data-testid=archived-drawer]';
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.querySelector('${archives}').getAnimations({subtree:true}).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-archives-readable-${width}.png`));
      expect(await page.evaluate(`Array.from(document.querySelectorAll('${width < 720 ? '[data-testid=archived-list]' : '[data-testid=archived-drawer]'} li')).every(row => {
        const title = row.querySelector('.title');
        const action = row.querySelector('[data-testid=${width < 720 ? 'archived-restore' : 'archived-drawer-restore'}]');
        return title.getBoundingClientRect().bottom <= action.getBoundingClientRect().top && title.scrollWidth <= title.clientWidth;
      })`)).toBe(true);
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      if (width >= 720) {
        const drawer = '[data-testid=archived-drawer]';
        await page.click(`${drawer} [data-testid=archived-drawer-delete]`);
        await page.waitFor(`document.querySelectorAll('${drawer} li').length === 6`);
        expect(await page.evaluate(`document.querySelector('[data-testid=confirm-dialog]') === null`)).toBe(true);
        await page.click('[data-testid=undo-action]');
        await page.waitFor(`document.querySelectorAll('${drawer} li').length === 7`);
        await page.click(`${drawer} [data-testid=archived-drawer-restore]`);
        await page.waitFor(`document.querySelectorAll('${drawer} li').length === 6`);
      }
    } finally { await page.close(); }
  }, 60_000);

  test(`deleting conversations at ${width}px supports restoration and configurable retention`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&updates=1`, windowSize: { width, height: 900 } });
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
      };
      await openMenu();
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-menu-${width}.png`));
      await chooseDelete();
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(id)})`);
      expect(await page.evaluate(`document.querySelector('[data-testid=confirm-dialog]') === null`)).toBe(true);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.list', { includeArchived: true }).then(rows => rows.some(t => t.id === ${JSON.stringify(id)}))`)).toBe(false);
      await page.waitFor(`document.querySelector('[data-testid=undo-action]')`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-undo-${width}.png`));
      await page.click('[data-testid=undo-action]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === ${JSON.stringify(id)}`);
      await openMenu(); await chooseDelete();
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(id)})`);
      await page.waitFor(`document.querySelector('[data-testid=undo-toast]')`);
      await page.waitFor(`!document.querySelector('[data-testid=undo-toast]')`, 12_000);
      expect(await page.evaluate(`document.querySelectorAll('[data-testid=harness-update-notice]').length`)).toBe(2);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-auto-dismiss-${width}.png`));
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      if (width < 720) {
        await mobileAction(page, 'mobile-settings');
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
      expect(await page.evaluate(`document.querySelector('[data-testid=confirm-dialog]') === null`)).toBe(true);
      await page.waitFor(`!document.querySelector('[data-testid=archived-list] [data-thread-id="${archivedId}"]')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.list', { includeArchived: true }).then(rows => rows.some(t => t.id === ${JSON.stringify(archivedId)}))`)).toBe(false);
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      await page.waitFor(`document.querySelector('[data-testid=deleted-show]') || document.querySelector('[data-testid=deleted-list]')`);
      if (await page.evaluate(`document.querySelector('[data-testid=deleted-show]') !== null`)) await page.click('[data-testid=deleted-show]');
      await page.waitFor(`document.querySelectorAll('[data-testid=deleted-list] li').length === 2`);
      expect(await page.evaluate(`document.querySelector('[data-testid=deleted-retention-days]').value`)).toBe('30');
      await page.choose('[data-testid=deleted-retention-days]', '7');
      await page.click('[data-testid=deleted-retention-save]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.settings.threadDeletionRetentionDays === 7`);
      expect(await page.evaluate(`document.querySelectorAll('[data-testid=deleted-list] .expiry').length`)).toBe(2);
      await page.evaluate(`document.querySelector('[data-testid=deleted-threads]').scrollIntoView({block:'center'}); document.querySelector('[data-testid=undo-toast] button:last-child')?.click()`);
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-delete-retention-${width}.png`));
      await page.click(`[data-testid=deleted-list] [data-thread-id="${archivedId}"] [data-testid=deleted-restore]`);
      await page.waitFor(`!document.querySelector('[data-testid=deleted-list] [data-thread-id="${archivedId}"]')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId: ${JSON.stringify(archivedId)}}).then(t => t.archived)`)).toBe(true);
      await page.click(`[data-testid=deleted-list] [data-thread-id="${id}"] [data-testid=deleted-restore]`);
      await page.waitFor(`document.querySelector('[data-testid=deleted-empty]')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId: ${JSON.stringify(id)}}).then(t => t.archived)`)).toBe(false);
    } finally {
      await page.close();
    }
  }, 60_000);
}
