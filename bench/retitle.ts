/** Retitle a 5,000-message thread on a temporary core with the offline echo driver.
 * Run: bun run bench/retitle.ts
 */
import { echoThread, startTestCore } from '../packages/core/test/harness.ts';

const harness = await startTestCore();
try {
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const journal = harness.core.journal;
  journal.db.transaction(() => {
    for (let index = 0; index < 5000; index++) journal.putMessage({
      id: `bench-message-${index}`, threadId, turnId: 'bench-turn',
      role: index % 2 === 0 ? 'user' : 'assistant', state: 'done', createdAt: index,
      parts: [{ type: 'text', text: index === 0 ? 'Inspect the first exchange only' : 'history '.repeat(1000) }],
    });
  })();
  const samples: number[] = [];
  for (let run = 0; run < 7; run++) {
    const start = performance.now();
    const result = await harness.core.threads.retitle(threadId);
    if (result.title !== 'Echo: Inspect the first exchange only') throw new Error(`unexpected title: ${result.title}`);
    if (run > 0) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  console.log(JSON.stringify({ messages: 5000, textBytes: 4999 * 8000, runs: samples.length, medianMs: samples[Math.floor(samples.length / 2)], samplesMs: samples }));
} finally { await harness.stop(); }
