import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { mobileAction } from './lib/mobile.ts';

let server: { close(): Promise<void> };
let port: number;
beforeAll(async () => {
  port = await freePort();
  server = await startUi(port);
}, 120_000);
afterAll(async () => { await server?.close(); });

for (const width of [1280, 390]) {
  test(`thread menus at ${width}px archive waiting work separately from Mark done`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width, height: width < 720 ? 844 : 900 } });
    try {
      await page.waitFor(`globalThis.__boiteTest?.workspace.active.openThread && document.querySelector('[data-testid=thread-header]')`);
      await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
      if (width < 720) {
        await mobileAction(page, 'mobile-conversations');
        await page.click('[data-testid=mobile-thread-menu-t-bench]');
      } else {
        await page.click('[data-testid=thread-row][data-thread-id=t-bench] ~ [data-testid=thread-menu]');
      }
      const menu = '[role=menu]:not(.closing)';
      await page.waitFor(`document.querySelector('${menu} [data-value=archive]')`);
      expect(await page.evaluate(`document.querySelector('${menu} [data-value=done]').disabled`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${menu} [data-value=archive]').disabled`)).toBe(false);
      expect((await page.text(`${menu} [data-value=archive]`)).trim()).toBe('Archive');
      expect(await page.evaluate(`Array.from(document.querySelectorAll('${menu} [role=menuitem]')).every(row => row.querySelector('svg'))`)).toBe(true);
      expect(await page.evaluate(`document.querySelector('${menu} [data-value=delete]').previousElementSibling.getAttribute('role')`)).toBe('separator');
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      expect(await page.evaluate(`(() => { const r = document.querySelector('${menu}').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-menu-row-${width}.png`));
      await page.click(`${menu} [data-value=archive]`);
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === 't-bench')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.pendingPermissions.some(p => p.threadId === 't-bench')`)).toBe(false);
      expect(await page.evaluate(`document.querySelector('[data-testid=confirm-dialog]') === null`)).toBe(true);
      await page.click('[data-testid=undo-action]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.threads.some(t => t.id === 't-bench')`);
      // Done uses a fresh idle conversation; the pending seed also has a static scheduler entry.
      const idleId = await page.evaluate<string>(`(async () => {
        const client = globalThis.__boiteTest.workspace.active.client;
        const source = await client.call('threads.get', {threadId: 't-bench'});
        return (await client.call('threads.create', {projectId: source.projectId, providerId: source.providerId, accountId: source.accountId, model: source.model, title: 'Ready to finish'})).id;
      })()`);
      await page.click(width < 720 ? `[data-testid=mobile-thread-menu-${idleId}]` : `[data-testid=thread-row][data-thread-id="${idleId}"] ~ [data-testid=thread-menu]`);
      await page.waitFor(`document.querySelector('${menu} [data-value=done]')`);
      expect(await page.evaluate(`document.querySelector('${menu} [data-value=done]').disabled`)).toBe(false);
      await page.click(`${menu} [data-value=done]`);
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(idleId)})`);
      await page.click('[data-testid=undo-action]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.threads.some(t => t.id === ${JSON.stringify(idleId)})`);
      if (width < 720) {
        // Newly shared row actions must reach the phone's title editor and project picker.
        await page.click('[data-testid=mobile-thread-menu-t-bench]');
        await page.click(`${menu} [data-value=move]`);
        await page.waitFor(`document.querySelector('[data-testid=context-menu] [data-value=p-notes]')`);
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
        await page.waitFor(`!document.querySelector('[data-testid=context-menu]')`);
        await page.click('[data-testid=mobile-thread-menu-t-bench]');
        await page.click(`${menu} [data-value=rename]`);
        await page.waitFor(`document.querySelector('[data-testid=thread-rename-input]')`);
        await page.type('[data-testid=thread-rename-input]', 'Restored thread from phone');
        await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
        await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.title === 'Restored thread from phone'`);
      } else await page.click('[data-testid=thread-row][data-thread-id=t-bench]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === 't-bench'`);
      await page.click('[data-testid=thread-menu-trigger]');
      await page.waitFor(`document.querySelector('${menu} [data-value=archive]')`);
      expect(await page.evaluate(`document.querySelector('${menu} [data-value=archive]').disabled`)).toBe(false);
      await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `thread-menu-header-${width}.png`));
      await page.click(`${menu} [data-value=archive]`);
      await page.waitFor(`!globalThis.__boiteTest.workspace.active.threads.some(t => t.id === 't-bench')`);
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      expect(page.errors()).toEqual([]);
    } finally { await page.close(); }
  }, 60_000);
}
