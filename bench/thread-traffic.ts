/** Actual compressed WebSocket bytes and snapshot latency through a delayed TCP relay.
 * Run: bun bench/thread-traffic.ts [--rtt 150] [--runs 7] [--mbps 2] [--attachment-kib 192]
 * Both strategies use the same temporary core, history and compression settings.
 */
import { randomBytes } from 'node:crypto';
import { echoThread, startTestCore } from '../packages/core/test/harness';
import { connect, type CoreClient } from '../packages/core/src/client';
import { INITIAL_MESSAGE_PAGE, MESSAGE_PAGE_MAX, resumeAnchor, type Thread } from '../packages/contracts/src/index';
import { startWire } from './lib/wire';

const option = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const rtt = option('rtt', 150), runs = option('runs', 7);
const mbps = option('mbps', Infinity);
const attachmentBytes = option('attachment-kib', 192) * 1024;
if (!Number.isSafeInteger(runs) || runs < 1 || !Number.isFinite(rtt) || rtt < 0 || !(mbps > 0) || !Number.isSafeInteger(attachmentBytes) || attachmentBytes < 0) throw new Error('expected positive runs and mbps, nonnegative rtt and attachment-kib');
const harness = await startTestCore();
const relay = startWire(harness.server.port, rtt / 2, mbps * 1_000_000 / 8);
let client: CoreClient | undefined;
try {
  const owner = await harness.connect();
  const { threadId } = await echoThread(harness, owner, 'Traffic fixture');
  const data = randomBytes(attachmentBytes).toString('base64');
  harness.core.journal.db.transaction(() => {
    harness.core.journal.putTurn({ id: 'traffic-turn', threadId, status: 'done', queuedAt: 1, startedAt: 1, finishedAt: 2, usage: null, error: null });
    for (let index = 0; index < 400; index++) harness.core.journal.putMessage({
      id: `traffic-${index}`, threadId, turnId: 'traffic-turn', role: index % 2 ? 'assistant' : 'user', state: 'complete', createdAt: index,
      parts: index === 399 && attachmentBytes ? [{ type: 'file', name: 'fixture.bin', mimeType: 'application/octet-stream', data }]
        : [{ type: 'text', text: `Message ${index}: ${'the conversation has a stable history and a bounded reading window. '.repeat(20)}` }]
    });
  })();
  client = await connect(relay.url, harness.token, { headers: { host: 'traffic.fixture.test' }, client: { name: 'bench', version: 'test' } });
  const rows: unknown[] = [];
  const visits = new Map<boolean, Thread>();
  for (const cold of [true, false]) {
    for (let sample = 0; sample < runs; sample++) {
      for (const optimized of sample % 2 ? [true, false] : [false, true]) {
        if (optimized && !client.core.features?.threadSnapshots) continue;
        let held = visits.get(optimized);
        await Bun.sleep(rtt + 25);
        relay.reset();
        const started = performance.now();
        const after = !cold && held ? resumeAnchor(held) : null;
        const params = { threadId, ...(after ? { after } : {}), limit: cold ? INITIAL_MESSAGE_PAGE : MESSAGE_PAGE_MAX, compactTools: true };
        if (optimized) {
          const snapshot = await client.call('threads.get', { ...params, compactFiles: true, sync: (!cold && held?.messagesSync) || true, open: { markRead: true } });
          if (snapshot.messagesUnchanged && held) snapshot.messages = held.messages;
          held = snapshot;
        } else {
          const subscribed = client.call('threads.subscribe', { threadId });
          const fetched = client.call('threads.get', params);
          await Promise.all([subscribed, fetched, client.call('permissions.list', { threadId }), client.call('questions.list', { threadId })]);
          held = await fetched;
        }
        const ms = performance.now() - started;
        const wire = relay.read();
        rows.push({ strategy: optimized ? 'snapshot' : 'current', phase: cold ? 'cold' : 'quiet-return', sample, ...wire, ms });
        if (held.messages.at(-1)?.id !== 'traffic-399') throw new Error(`the latest message was lost: ${held.messages.length} messages, last=${held.messages.at(-1)?.id}`);
        visits.set(optimized, held);
      }
    }
  }
  await client.call('threads.unsubscribe', { threadId });
  console.log(JSON.stringify({ date: new Date().toISOString(), rttMs: rtt, mbps: Number.isFinite(mbps) ? mbps : null, runs, messages: 400, attachmentBytes, rows }, null, 2));
} finally {
  client?.close(); relay.stop(); await harness.stop();
}
