import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { connect } from '../../packages/core/src/client.ts';
import { BrowserPage } from './lib/cdp.ts';
import { pairingUrlOf, startCore } from './lib/core.ts';
import { startCoreWithLongThread } from './lib/long-thread.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

const timeline = '[data-testid=timeline]';

/**
 * 100 turns whose answers a long session leaves, a paragraph after every
 * dozen calls, 195 parts cut in four rows each (`lib/timeline-rows.ts`), then
 * 20 short turns, the first page. Message ids are `msg_cut<turn><u|a>`.
 */
function seedCutAnswers(dataDir: string, threadId: string): { messages: number; bytes: number } {
  const db = new Database(join(dataDir, 'journal.db'));
  const turn = db.prepare('INSERT INTO turns (id, thread_id, status, queued_at, started_at, finished_at, usage, error) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)');
  const message = db.prepare('INSERT INTO messages (id, thread_id, turn_id, role, parts, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const start = Date.now() - 120 * 60_000;
  let bytes = 0;
  db.transaction(() => {
    for (let index = 0; index < 120; index += 1) {
      const id = String(index).padStart(3, '0'), at = start + index * 60_000;
      turn.run(`turn_cut${id}`, threadId, 'done', at, at, at + 50_000);
      const answer = index < 100
        ? Array.from({ length: 15 }, (_, run) => [
          ...Array.from({ length: 12 }, (_, call) => ({ type: 'tool', toolId: `tool_${index}_${run}_${call}`, name: 'Bash', input: { command: `rg step${call} packages` }, output: `packages/step${call}.ts:1: found`, status: 'done', startedAt: at + call, finishedAt: at + call + 1 })),
          { type: 'text', text: `Run ${run} of turn ${index} is done, and the next one reads what it left.` },
        ]).flat()
        : [{ type: 'text', text: `Short answer ${index}, a paragraph long enough to wrap across the conversation column at least once.` }];
      for (const [role, parts, offset] of [['user', [{ type: 'text', text: `Turn ${index}.` }], 0], ['assistant', answer, 1]] as const) {
        const json = JSON.stringify(parts);
        bytes += json.length;
        message.run(`msg_cut${id}${role[0]}`, threadId, `turn_cut${id}`, role, json, 'complete', at + offset);
      }
    }
  })();
  db.close();
  return { messages: 240, bytes };
}

test('history read above rows the window never measured stays still once the wheel stops', async () => {
  ensureProductionUi();
  const core = await startCore();
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let page: BrowserPage | undefined;
  try {
    client = await connect(core.url, core.token);
    await client.call('brain.configure', { path: null, enabled: false, boiteGuide: false });
    const project = await client.call('projects.add', { path: core.dataDir, name: 'History' });
    const account = (await client.call('accounts.list', {})).find(account => account.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, permissionMode: 'default', title: 'Long answers' });
    // Answers several times taller than the window's 80 px estimate.
    for (let turn = 0; turn < 14; turn++) {
      await client.call('turns.start', { threadId: thread.id, prompt: `Turn ${turn}. ` + 'A paragraph long enough to wrap across the conversation column.\n\n'.repeat(10) });
      for (let wait = 0; wait < 200; wait++) {
        const { turns } = await client.call('threads.get', { threadId: thread.id });
        if (turns.every(each => each.status !== 'running' && each.status !== 'queued')) break;
        await Bun.sleep(50);
      }
    }
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    await page.click(`[data-thread-id="${thread.id}"]`);
    await page.waitFor(`document.querySelectorAll('${timeline} [data-mid]').length > 0`);
    const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${timeline}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    for (let notch = 0; notch < 60; notch++) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
      await Bun.sleep(100);
    }
    await Bun.sleep(500);
    // A row the window mounted and dropped before its measurement frame kept its estimate: the
    // shorter spacer moved the anchored list, which mounted the row again, sixteen times a second.
    const churn = await page.evaluate<{ rows: number; tops: number }>(`new Promise((done) => {
      const box = document.querySelector('${timeline}');
      let rows = 0;
      const tops = new Set([Math.round(box.scrollTop)]);
      const watch = new MutationObserver((records) => { for (const record of records) for (const node of [...record.addedNodes, ...record.removedNodes]) if (node instanceof HTMLElement && node.matches('[data-mid]')) rows += 1; });
      watch.observe(box, { childList: true, subtree: true });
      const onScroll = () => tops.add(Math.round(box.scrollTop));
      box.addEventListener('scroll', onScroll);
      setTimeout(() => { watch.disconnect(); box.removeEventListener('scroll', onScroll); done({ rows, tops: tops.size }); }, 1000);
    })`);
    expect(churn).toEqual({ rows: 0, tops: 1 });
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); client?.close(); await core.stop(); }
}, 120_000);

test('pages of long answers landing above a reader leave the reader on the stretch it reads', async () => {
  ensureProductionUi();
  const { core, long } = await startCoreWithLongThread({}, undefined, seedCutAnswers);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: pairingUrlOf(core), windowSize: { width: 1280, height: 900 } });
    await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"');
    // The pages read by position, as they are answered.
    await page.evaluate(`(() => {
      window.__asked = 0;
      window.__pages = 0;
      const send = WebSocket.prototype.send, asked = new Set(), watched = new WeakSet();
      WebSocket.prototype.send = function (data) {
        try { const call = JSON.parse(data); if (call.method === 'messages.list') { asked.add(call.id); window.__asked += 1; } } catch {}
        if (!watched.has(this)) { watched.add(this); this.addEventListener('message', (event) => { try { if (asked.delete(JSON.parse(event.data).id)) window.__pages += 1; } catch {} }); }
        return send.call(this, data);
      };
    })()`);
    await page.click(`[data-thread-id="${long}"]`);
    await page.waitFor(`document.querySelectorAll('${timeline} [data-mid]').length > 0`);
    await page.evaluate('new Promise((done) => setTimeout(done, 500))');
    expect(await page.evaluate<number>('window.__asked')).toBe(0);
    // Which message is at the top of the view, every frame, while the pages above it land.
    await page.evaluate(`(() => {
      const box = document.querySelector('${timeline}');
      window.__tops = [];
      const frame = () => {
        const top = box.getBoundingClientRect().top;
        const row = [...box.querySelectorAll('[data-mid]')].find((node) => node.getBoundingClientRect().bottom > top);
        window.__tops.push(row ? (row.dataset.message ?? row.dataset.mid) : 'none');
        window.__frame = requestAnimationFrame(frame);
      };
      frame();
    })()`);
    const box = await page.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('${timeline}').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    // Up a notch at a time until the first page is asked, three screens ahead of the reader.
    for (let notch = 0; notch < 40 && await page.evaluate<number>('window.__asked') === 0; notch += 1) {
      await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: -120 });
      await Bun.sleep(150);
    }
    await page.waitFor('window.__pages >= 1', 10_000);
    await page.evaluate('new Promise((done) => setTimeout(done, 1_000))');
    const tops = await page.evaluate<string[]>('(() => { cancelAnimationFrame(window.__frame); return [...new Set(window.__tops)]; })()');
    // A page's answers weigh four cut rows each where the gap counted 80 px: the reader's row left
    // the rows drawn, its place went uncorrected, and the view showed answers far above or the skeleton.
    expect(tops.filter((id) => !/^msg_cut1[01]\d[ua]$/.test(id))).toEqual([]);
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await core.stop(); }
}, 120_000);
