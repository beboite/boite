/**
 * The history a fresh session carries (model switch, resume after an update)
 * on a long echo thread, on a temporary core: `messages` assistant messages
 * with one tool output of `toolKiB` each, and `files` attached files of
 * `fileKiB` spread through the thread. The first run writes the file copies;
 * the next ones time the repeat continuation a thread makes after that.
 * Run: bun run bench/continuation.ts [messages=100] [toolKiB=1024] [files=25] [fileKiB=1100]
 */
import * as attachments from '../packages/core/src/attachments.ts';
import { continuationInput } from '../packages/core/src/continuation.ts';
import { echoThread, startTestCore } from '../packages/core/test/harness.ts';

const arg = (at: number, fallback: number): number => Number(process.argv[2 + at] ?? fallback);
const messages = arg(0, 100), toolKiB = arg(1, 1024), files = arg(2, 25), fileKiB = arg(3, 1100);
const harness = await startTestCore();
try {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const journal = harness.core.journal;
  const every = files > 0 ? Math.max(1, Math.floor(messages / files)) : Infinity;
  journal.db.transaction(() => {
    for (let index = 0; index < messages; index++) {
      journal.putMessage({
        id: `bench-user-${index}`, threadId, turnId: `bench-turn-${index}`, role: 'user', state: 'complete', createdAt: 2 * index,
        parts: [{ type: 'text', text: `request ${index}` }, ...(index % every === 0 && index / every < files
          ? [{ type: 'file' as const, name: `notes-${index}.bin`, mimeType: 'application/octet-stream', data: Buffer.alloc(fileKiB * 1024, index % 251).toString('base64') }]
          : [])],
      });
      journal.putMessage({
        id: `bench-assistant-${index}`, threadId, turnId: `bench-turn-${index}`, role: 'assistant', state: 'complete', createdAt: 2 * index + 1,
        parts: [{ type: 'tool', toolId: `call-${index}`, name: 'Read', input: { index }, status: 'done', output: String.fromCharCode(97 + index % 26).repeat(toolKiB * 1024) }],
      });
    }
  })();
  const provider = harness.core.providers.require('echo');
  // What the core passes for file parts on this checkout: the per-thread lines where they exist.
  const memo = 'FileReferences' in attachments ? new attachments.FileReferences(harness.dataDir) : null;
  const reference = (part: Parameters<typeof attachments.fileReference>[1], place: { messageId: string; partIndex: number }): string =>
    memo ? memo.of(threadId, part as never, place) : attachments.fileReference(harness.dataDir, part);
  const samples: number[] = [], rss: number[] = [];
  let length = 0;
  for (let run = 0; run < 7; run++) {
    Bun.gc(true);
    const before = process.memoryUsage().rss, start = performance.now();
    const result = continuationInput(journal, threadId, 'bench-next', { prompt: 'Continue', attachments: [] }, provider, reference as never);
    const elapsed = performance.now() - start;
    length = result.prompt.length;
    if (run > 0) { samples.push(elapsed); rss.push((process.memoryUsage().rss - before) / 1024 / 1024); }
  }
  const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  console.log(JSON.stringify({ messages, toolKiB, files, fileKiB, promptChars: length, runs: samples.length, medianMs: Number(median(samples).toFixed(2)), medianRssMiB: Number(median(rss).toFixed(1)), samplesMs: samples.map(value => Number(value.toFixed(2))) }));
} finally { await harness.stop(); }
