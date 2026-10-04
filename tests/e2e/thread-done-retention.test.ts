import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { mobileAction } from './lib/mobile.ts';

let server: { close(): Promise<void> }, port: number;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); });

for (const width of [1280, 390]) {
  test(`done retention defaults to three days and saves validated settings at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width, height: 900 } });
    try {
      await page.waitFor(`globalThis.__boiteTest?.workspace.active.openThread`);
      await page.evaluate(`globalThis.__boiteTest.setTheme('dark')`);
      const threadId = await page.evaluate<string>(`(async () => {
        const client = globalThis.__boiteTest.workspace.active.client;
        const source = await client.call('threads.get', {threadId: 't-parser'});
        const thread = await client.call('threads.create', {projectId: source.projectId, providerId: source.providerId, accountId: source.accountId, model: source.model, title: 'A finished conversation'});
        await client.call('threads.archive', {threadId: thread.id, onlyIfIdle: true});
        return thread.id;
      })()`);
      if (width < 720) {
        await mobileAction(page, 'mobile-settings');
        await page.click('[data-testid=mobile-settings-archived]');
      } else {
        await page.click('[data-testid=nav-settings]');
        await page.click('[data-testid=settings-tab-general]');
        await page.click('[data-testid=archived-show]');
      }
      await page.waitFor(`document.querySelector('[data-testid=done-expires]')`);
      expect(await page.evaluate(`document.querySelector('[data-testid=done-retention-days]').value`)).toBe('3');
      await page.evaluate(`document.querySelector('[data-testid=done-retention-days]').scrollIntoView({block:'center'})`);
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.querySelector('[data-testid=archived-threads]').getAnimations({subtree:true}).filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `done-retention-${width}.png`));
      expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
      await page.choose('[data-testid=done-retention-days]', '0.5');
      expect(await page.evaluate(`document.querySelector('[data-testid=done-retention-save]').disabled`)).toBe(true);
      await page.choose('[data-testid=done-retention-days]', '7');
      await page.click('[data-testid=done-retention-save]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.settings.threadDoneRetentionDays === 7`);
      const doneAt = await page.evaluate<number>(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId: ${JSON.stringify(threadId)}}).then(t => t.doneAt)`);
      expect(await page.evaluate(`document.querySelector('[data-testid=done-expires]').textContent.includes(new Date(${doneAt + 7 * 86_400_000}).toLocaleString())`)).toBe(true);
      await page.choose('[data-testid=done-retention-days]', '0');
      await page.click('[data-testid=done-retention-save]');
      await page.waitFor(`globalThis.__boiteTest.workspace.active.settings.threadDoneRetentionDays === 0 && !document.querySelector('[data-testid=done-expires]')`);
      await page.click(`[data-thread-id="${threadId}"] [data-testid=archived-restore]`);
      await page.waitFor(`document.querySelector('[data-testid=archived-open]')`);
      expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('threads.get', {threadId: ${JSON.stringify(threadId)}}).then(t => t.doneAt)`)).toBeNull();
    } finally { await page.close(); }
  }, 60_000);
}
