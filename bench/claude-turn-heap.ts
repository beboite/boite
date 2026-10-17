/**
 * Heap and RSS a scripted Claude turn leaves in the core, on a warm session.
 * The turn writes TOOLS Write calls whose input holds 256 KiB and whose result
 * holds 1 MiB, each followed by its `tool_use_summary`, with an IMAGE_MIB image
 * on the prompt. Three readings, each after `Bun.gc(true)`, minus the reading
 * before the turn:
 *
 * - `open`: the turn still running, every summary landed. With STEER=1 a
 *   follow-up cuts the answer first, so the cards' message is closed and written.
 * - `idle`: the turn finished, the session still warm (30 minutes).
 *
 * No real agent runs: the driver talks to the test suite's scripted query.
 *
 * Run: bun bench/claude-turn-heap.ts
 *      STEER=1 IMAGE_MIB=0 bun bench/claude-turn-heap.ts
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heapStats } from 'bun:jsc';
import { scriptedClaude, startTestCore } from '../packages/core/test/harness.ts';
import { assistant, calls, init, scripted, sdk, streamEvent, success, toolResult } from '../packages/core/test/fixtures/claude-query.ts';
import type { FakeQuery } from '../packages/core/test/fixtures/claude-query.ts';

const TOOLS = Number(process.env.TOOLS ?? 20);
const OUTPUT = 1 << 20;
const IMAGE = Number(process.env.IMAGE_MIB ?? 5) << 20;
const STEER = process.env.STEER === '1';
const SESSION = 'sess-heap';

const harness = await startTestCore({ settings: { warmProcessMinutes: 30 } });
scriptedClaude(harness);
const client = await harness.connect();
const project = await client.call('projects.add', { path: harness.dataDir, name: 'claude' });
const account = await client.call('accounts.add', { providerId: 'claude', label: 'scripted' });
writeFileSync(join(account.isolationDir!, '.credentials.json'), '{}');
await client.call('accounts.check', { accountId: account.id });
const thread = await client.call('threads.create', { projectId: project.id, providerId: 'claude', accountId: account.id, title: 'heap' });
await client.call('threads.update', { threadId: thread.id, title: 'heap' });
const threadId = thread.id;

const apiMessage = (id: string, content: unknown[]): ReturnType<typeof sdk> =>
  sdk({ type: 'assistant', session_id: SESSION, parent_tool_use_id: null, message: { id, role: 'assistant', model: 'claude-opus-5', content } });

let query: FakeQuery | undefined;
scripted((fake) => { query = fake; }, (fake, _prompt, index) => {
  if (index > 0) {
    // A follow-up joins the running turn.
    if (STEER) return;
    fake.emit(init(SESSION));
    fake.emit(assistant(SESSION, [{ type: 'text', text: 'ok' }]));
    fake.emit(success(SESSION));
    return;
  }
  fake.emit(init(SESSION));
  for (let i = 0; i < TOOLS; i++) {
    const id = `toolu_${i}`;
    const text = `step ${i} `.repeat(2000);
    fake.emit(streamEvent(SESSION, { type: 'message_start', message: { id: `msg_${i}` } }));
    fake.emit(streamEvent(SESSION, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    fake.emit(streamEvent(SESSION, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    fake.emit(apiMessage(`msg_${i}`, [{ type: 'text', text }]));
    fake.emit(apiMessage(`msg_${i}`, [{ type: 'tool_use', id, name: 'Write', input: { file_path: `/tmp/f${i}.txt`, content: String.fromCharCode(97 + (i % 26)).repeat(OUTPUT / 4) } }]));
    fake.emit(toolResult(SESSION, id, String.fromCharCode(65 + (i % 26)).repeat(OUTPUT)));
    fake.emit(sdk({ type: 'tool_use_summary', summary: `Wrote f${i}`, preceding_tool_use_ids: [id], uuid: `u${i}`, session_id: SESSION }));
  }
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Part = ReturnType<typeof harness.core.journal.listMessages>[number]['parts'][number];
const tools = (): Extract<Part, { type: 'tool' }>[] =>
  harness.core.journal.listMessages(threadId).flatMap(m => m.parts).filter((p): p is Extract<Part, { type: 'tool' }> => p.type === 'tool');
const measure = async (): Promise<{ heap: number; rss: number }> => {
  // Past the stream buffer's 500 ms persist delay, then a full collection.
  await sleep(700);
  for (let i = 0; i < 3; i++) { Bun.gc(true); await sleep(50); }
  return { heap: heapStats().heapSize, rss: process.memoryUsage().rss };
};

const before = await measure();
const finished = client.next('turn.finished', turn => turn.threadId === threadId, 60_000);
const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: Buffer.alloc(IMAGE, 7).toString('base64'), name: 'big.png' };
const turn = await client.call('turns.start', { threadId, prompt: 'go', attachments: IMAGE > 0 ? [image] : [] });
for (let i = 0; i < 400 && tools().filter(p => p.summary).length < TOOLS; i++) await sleep(50);
if (STEER) {
  await client.call('turns.steer', { threadId, turnId: turn.id, prompt: 'and then?', clientRequestId: 'steer_heap_01' });
  for (let i = 0; i < 200 && calls[0]?.prompts.length !== 2; i++) await sleep(25);
  query!.emit(assistant(SESSION, [{ type: 'text', text: 'after the follow-up' }]));
}
const open = await measure();
query!.emit(success(SESSION));
await finished;
// The scripted query keeps every prompt it read, image included: not the core's.
for (const call of calls) call.prompts.length = 0;
const idle = await measure();

const written = tools();
const ok = written.length === TOOLS && written.every(p => p.summary && p.output?.length === OUTPUT && (p.input as { content?: string }).content?.length === OUTPUT / 4);
const mib = (bytes: number) => Number((bytes / 1_048_576).toFixed(1));
console.log(JSON.stringify({
  ok,
  openHeapMiB: mib(open.heap - before.heap), idleHeapMiB: mib(idle.heap - before.heap),
  openRssMiB: mib(open.rss - before.rss), idleRssMiB: mib(idle.rss - before.rss),
}));
await harness.stop();
process.exit(ok ? 0 : 1);
