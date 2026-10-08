import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { labelOffsets } from './lib/text-metrics';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
  page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  await page.waitFor('globalThis.__boiteTest?.workspace.active?.connection === "ready"');
}, 90_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`retained prompts remain usable at ${viewport.width}px`, async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 720 });
    await page.evaluate(`(async () => {
      const store = globalThis.__boiteTest.workspace.active;
      const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', title: 'Recovery checks' });
      store.client.holdAfterRestart(thread.id, 'Review the saved changes after restart');
      await store.open(thread.id);
    })()`);
    await page.waitFor('document.querySelector("[data-testid=thread-recovery]") !== null');
    if (viewport.width === 1280) {
      for (const font of ['inter', 'geist', 'plex', 'atkinson', 'figtree', 'source', 'dm', 'system']) {
        await page.evaluate(`(async () => {
          document.documentElement.dataset.font = '${font}';
          const family = getComputedStyle(document.body).fontFamily;
          await document.fonts.load('600 13px ' + family);
          await document.fonts.load('500 13px ' + family);
          await document.fonts.ready;
        })()`);
        for (const result of await labelOffsets(page, [
          ['[data-testid="thread-recovery"] > svg', '[data-testid="thread-recovery"] .title .ui-label'],
          ['[data-testid="thread-recovery"] button', '[data-testid="thread-recovery"] button .ui-label'],
        ])) expect(Math.abs(result.offset), `${font}: recovery text`).toBeLessThanOrEqual(0.8);
      }
      await page.evaluate(`document.documentElement.dataset.font = 'inter'; document.fonts.ready`);
    }
    await page.evaluate('document.fonts.ready');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', `orchestration-held-${viewport.width}.png`));
    await page.click('[data-testid=thread-recovery] button');
    await page.waitFor('document.querySelector("[data-testid=thread-recovery]") === null');
    await page.waitFor('globalThis.__boiteTest.workspace.active.openThread.status === "idle"');
    const identity = await page.evaluate<{ users: number; turns: number; status: string }>(`(() => {
      const thread = globalThis.__boiteTest.workspace.active.openThread;
      return { users: thread.messages.filter(m => m.role === 'user').length, turns: thread.turns.length, status: thread.turns[0].status };
    })()`);
    expect(identity).toEqual({ users: 1, turns: 1, status: 'done' });
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', `orchestration-resumed-${viewport.width}.png`));
    await page.evaluate(`(async () => {
      const store = globalThis.__boiteTest.workspace.active;
      const message = store.openThread.messages.at(-1);
      await store.fork(message.id);
    })()`);
    await page.waitFor('document.querySelector("[data-testid=fork-return]") !== null');
    await page.click('[data-testid=fork-return] summary');
    await page.evaluate(`(() => {
      const input = document.querySelector('[data-testid=fork-return-text]');
      input.value = 'The saved prompt resumed once and kept the original execution.';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await page.waitFor('document.querySelector("[data-testid=fork-return-send]").disabled === false');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.screenshot(join(import.meta.dir, '.artifacts', `orchestration-fork-${viewport.width}.png`));
    await page.click('[data-testid=fork-return-send]');
    await page.waitFor('document.querySelector("[data-testid=fork-return] [role=status]") !== null');
    const returned = await page.evaluate<number>(`(async () => {
      const store = globalThis.__boiteTest.workspace.active;
      const fork = store.openThread;
      const view = await store.client.call('collaboration.get', { threadId: fork.forkOrigin.threadId });
      return view.messages.filter(letter => letter.from.threadId === fork.id).length;
    })()`);
    expect(returned).toBe(1);
  }, 45_000);
}
