/** Runtime audit probes against a disposable journal and scripted drivers. */
import { ActivityStore } from '../src/activity.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { echoThread, startTestCore, waitFor } from '../test/harness.ts';
import { renderMarkdown } from '../../ui/src/lib/markdown.ts';

const h = await startTestCore();
let restore: (() => void) | undefined;
try {
  const client = await h.connect();
  const proxyOrigin = 'https://boite.example.test';
  const rejected = await fetch(`${h.url}/rpc`, { headers: { origin: proxyOrigin } });
  h.core.settings.set({ browserOrigins: [proxyOrigin] });
  const allowed = await fetch(`${h.url}/rpc`, { headers: { origin: proxyOrigin } });
  console.log(JSON.stringify({ probe: 'proxy-origin', beforeAllowlist: rejected.status, afterAllowlist: allowed.status }));
  const { threadId } = await echoThread(h, client);
  const journal = h.core.journal;
  let written = 0;
  for (const count of [100, 1000, 5000]) {
    journal.db.transaction(() => {
      for (; written < count; written++) journal.putMessage({
        id: `audit-${written}`, threadId, turnId: 'audit-history', role: 'assistant',
        parts: [{ type: 'text', text: 'x'.repeat(2048) }], state: 'complete', createdAt: written,
      });
    })();
    const times: number[] = [];
    for (let run = 0; run < 7; run++) {
      const start = performance.now();
      journal.listMessages(threadId);
      times.push(performance.now() - start);
    }
    console.log(JSON.stringify({ probe: 'history-read', messages: count, medianMs: +times.sort((a, b) => a - b)[3]!.toFixed(2) }));
  }
  let decoded = 0;
  const original = journal.listMessages.bind(journal);
  journal.listMessages = (id) => { const messages = original(id); decoded += messages.length; return messages; };
  restore = setDriver('echo', {
    protocol: 'echo',
    startTurn() { return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) }; },
  });
  const turn = h.core.threads.startTurn(threadId, 'latest prompt');
  await waitFor(() => journal.getTurn(turn.id)?.status === 'done');
  console.log(JSON.stringify({ probe: 'start-turn', historyMessages: 5000, decodedMessages: decoded }));
  journal.listMessages = original;
  restore(); restore = undefined;

  for (const scenario of ['quoted-marker', 'marker-before-page'] as const) {
    const { threadId: goalThread } = await echoThread(h, client, scenario);
    restore = setDriver('echo', {
      protocol: 'echo',
      startTurn(ctx) {
        const id = ctx.emit.startMessage('assistant');
        const text = scenario === 'quoted-marker'
          ? 'Not finished. This is the marker format:\n```\n[BOITE_GOAL_COMPLETE]\n```'
          : '[BOITE_GOAL_COMPLETE]';
        ctx.emit.part(id, 0, { type: 'text', text });
        ctx.emit.complete(id, 'complete');
        if (scenario === 'marker-before-page') for (let i = 0; i < 120; i++) {
          const extra = ctx.emit.startMessage('assistant');
          ctx.emit.part(extra, 0, { type: 'text', text: 'Additional output.' });
          ctx.emit.complete(extra, 'complete');
        }
        return { stop() {}, done: Promise.resolve({ status: 'done', sessionId: null, usage: null }) };
      },
    });
    h.core.activity.set({ threadId: goalThread, goal: { objective: 'Audit completion detection' } });
    await waitFor(() => h.core.activity.get(goalThread).goal!.iterations > 0 && h.core.threads.get(goalThread).status === 'idle');
    console.log(JSON.stringify({ probe: scenario, goalStatus: h.core.activity.get(goalThread).goal?.status }));
    h.core.activity.pauseAll(goalThread);
    restore(); restore = undefined;
  }

  const events = () => (journal.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'thread.activity'").get() as { n: number }).n;
  const before = events();
  h.core.activity.close();
  const afterClose = events();
  console.log(JSON.stringify({ probe: 'inactive-activity-close', addedEvents: afterClose - before }));
  // Exercise the startup loader against the saved, already paused activities.
  const reloaded = new ActivityStore(h.core);
  console.log(JSON.stringify({ probe: 'inactive-activity-boot', addedEvents: events() - afterClose }));
  reloaded.close();
  console.log(JSON.stringify({ probe: 'markdown-inline-code', html: renderMarkdown('`**literal**`') }));
} finally {
  restore?.();
  await h.stop();
}

// An accepted socket whose peer never answers hello must still respect timeoutMs.
const silent = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request, server) { return server.upgrade(request) ? undefined : new Response('upgrade required'); },
  websocket: { message() {} },
});
let settled = false;
const pending = connect(`http://127.0.0.1:${silent.port}`, 'synthetic-token', { timeoutMs: 20 })
  .then(client => { settled = true; client.close(); }, () => { settled = true; });
try {
  await Bun.sleep(100);
  console.log(JSON.stringify({ probe: 'hello-timeout', timeoutMs: 20, settledAfter100Ms: settled }));
} finally {
  void silent.stop(true);
  await pending;
}
