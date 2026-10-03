import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

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
  test(`retained prompts and native history remain usable at ${viewport.width}px`, async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: viewport.width < 720 });
    await page.evaluate(`(async () => {
      const store = globalThis.__boiteTest.workspace.active;
      const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo', title: 'Recovery checks' });
      store.client.holdAfterRestart(thread.id, 'Review the saved changes after restart');
      await store.open(thread.id);
      store.openThread.backgroundHistory = [{ id: 'native-review', threadId: thread.id, providerId: 'echo', sessionGeneration: 0,
        parentTurnId: null, kind: 'agent', description: 'Review the parser', toolId: null, startedAt: Date.now() - 10000,
        state: 'cancelled', observedAt: Date.now(), finishedAt: Date.now(), reason: 'core-restarted' }];
    })()`);
    await page.waitFor('document.querySelector("[data-testid=thread-recovery]") !== null');
    await page.click('[data-testid=background-history] summary');
    await page.evaluate('document.fonts.ready');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    expect(await page.evaluate('document.querySelector("[data-testid=background-history]").textContent.includes("Interrupted by a core restart")')).toBe(true);
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
