import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let url: string;
const store = 'globalThis.__boiteTest.workspace.active';

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}/?fake=1&open=recent`;
}, 60_000);
afterAll(async () => { await server?.close(); });

// A provider opened a second message in the middle of a turn: the call still
// running there sits under the finished ones at the gap of one message's parts.
test('a turn split across assistant messages reads as one run of work on desktop', async () => {
  const page = await BrowserPage.launch({ url, windowSize: { width: 1280, height: 900 } });
  try {
    await page.waitFor(`${store}?.connection === 'ready' && ${store}.openThread?.messages.length > 0`);
    await page.evaluate(`(() => {
      const thread = ${store}.openThread, now = Date.now(), turnId = 'seam-turn';
      const call = (id, status, at) => ({ type: 'tool', toolId: id, name: 'Bash', input: { command: 'bun test' }, output: status === 'done' ? 'ok' : null, status, startedAt: at, finishedAt: status === 'done' ? at + 5000 : undefined });
      thread.turns.push({ id: turnId, threadId: thread.id, status: 'running', queuedAt: now - 300000, startedAt: now - 266000, finishedAt: null, usage: null, error: null });
      thread.status = 'running';
      thread.messages.push(
        { id: 'seam-user', threadId: thread.id, turnId, role: 'user', parts: [{ type: 'text', text: 'Run the tests' }], state: 'complete', createdAt: now - 300000 },
        { id: 'seam-a', threadId: thread.id, turnId, role: 'assistant', parts: [{ type: 'text', text: 'Running them.' }, call('a1', 'done', now - 120000), call('a2', 'done', now - 110000)], state: 'complete', createdAt: now - 130000 },
        { id: 'seam-b', threadId: thread.id, turnId, role: 'assistant', parts: [call('b1', 'running', now - 83000)], state: 'streaming', createdAt: now - 83000 });
    })()`);
    await page.waitFor(`document.querySelector('[data-mid="seam-b"]')`);
    await page.evaluate('new Promise(resolve => setTimeout(resolve, 600))');
    await page.screenshot(join(import.meta.dir, '.artifacts', 'turn-seam-desktop.png'));
    const gap = await page.evaluate<number>(`document.querySelector('[data-mid="seam-b"]').getBoundingClientRect().top - document.querySelector('[data-mid="seam-a"] [data-testid=tool-group]').getBoundingClientRect().bottom`);
    // --chat-part-gap, where two messages would leave --chat-message-gap.
    expect(Math.round(gap)).toBe(4);
  } finally {
    await page.close();
  }
}, 60_000);
