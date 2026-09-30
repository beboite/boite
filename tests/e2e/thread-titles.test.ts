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
  test(`the generated title is visible during the first response at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&stream=tokens`, windowSize: { width, height: 900 } });
    try {
      await page.waitFor('globalThis.__boiteTest?.workspace.active.connection === "ready"');
      const threadId = await page.evaluate<string>(`(async () => {
        const store = globalThis.__boiteTest.workspace.active;
        const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
        await store.open(thread.id);
        await store.client.call('turns.start', { threadId: thread.id, prompt: 'Inspect scheduler startup while this long first answer keeps streaming. '.repeat(20) });
        return thread.id;
      })()`);
      await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.titleSource === 'agent'`);
      expect(await page.evaluate<string>('globalThis.__boiteTest.workspace.active.openThread.status')).toBe('running');
      await page.waitFor(`document.querySelector('[data-testid=thread-header]').textContent.includes('Echo: Inspect scheduler startup while this')`);
      if (width >= 720) {
        await page.waitFor(`document.querySelector('[data-testid=thread-row][data-thread-id="${threadId}"]').textContent.includes('Echo: Inspect scheduler startup while this')`);
      }
      await page.evaluate('document.fonts.ready');
      await page.screenshot(join(import.meta.dir, '.artifacts', `early-thread-title-${width}.png`));
      expect(await page.evaluate<boolean>('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
      await page.evaluate(`globalThis.__boiteTest.workspace.active.client.call('turns.stop', { threadId: ${JSON.stringify(threadId)} })`);
    } finally { await page.close(); }
  });
}
