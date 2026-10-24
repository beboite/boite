/** An agent snapshot over a long agent thread and a big table of records older cores left, on a temporary core.
 * Each step adds a finished turn with its prompt and answer to the agent's thread, and an old work row of
 * 20 KB that nothing reads any more.
 * Run: bun run bench/agents-snapshot.ts [steps]
 */
import { startTestCore } from '../packages/core/test/harness.ts';

const steps = Number(process.argv[2] ?? 2000);
const harness = await startTestCore();
try {
  const client = await harness.connect();
  await client.call('agents.limits.set', { paused: true });
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name: 'Bench', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active' } });
  const { threadId } = await client.call('agents.open', { agentId: agent.id });
  const journal = harness.core.journal;
  const execution = { providerId: 'echo', accountId: account.id, model: null, effort: null, speed: null, permissionMode: 'default' as const, sessionId: null, sessionGeneration: 0, selectionVersion: 0 };
  const now = Date.now();
  journal.db.transaction(() => {
    for (let i = 0; i < steps; i++) {
      const at = now - (steps - i) * 60_000;
      const turnId = `trn_bench${i}`;
      journal.putTurn({ id: turnId, threadId, status: 'done', queuedAt: at, startedAt: at, finishedAt: at + 1000, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0.01 }, error: null, execution: { ...execution, ...(i % 3 ? { operation: 'routine' as const } : {}) }, ...(i % 6 === 1 ? { quiet: true as const } : {}) });
      journal.putMessage({ id: `msg_benchq${i}`, threadId, turnId, role: i % 3 ? 'system' : 'user', parts: [{ type: 'text', text: `step ${i}` }], state: 'complete', createdAt: at });
      journal.putMessage({ id: `msg_bencha${i}`, threadId, turnId, role: 'assistant', parts: [{ type: 'text', text: i % 6 === 1 ? '[quiet] nothing new' : `answer ${i}` }], state: 'complete', createdAt: at + 1 });
      journal.db.query("INSERT INTO agent_entities (kind, id, revision, created_at, updated_at, data) VALUES ('work', ?, 1, ?, ?, ?)").run(`agt_work_bench${i}`, at, at, JSON.stringify({ prompt: 'x'.repeat(20_000) }));
    }
  })();
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  const snapshotMs: number[] = [], lookupMs: number[] = [];
  let bytes = 0;
  for (let run = 0; run < 7; run++) {
    let start = performance.now();
    const snapshot = await client.call('agents.snapshot', {});
    if (run > 0) snapshotMs.push(performance.now() - start);
    bytes = JSON.stringify(snapshot).length;
    start = performance.now();
    for (let i = 0; i < 100; i++) harness.core.workforce.agentOfThread(threadId);
    if (run > 0) lookupMs.push((performance.now() - start) / 100);
  }
  console.log(JSON.stringify({ steps, snapshotBytes: bytes, snapshotMedianMs: +median(snapshotMs).toFixed(2), threadLookupMedianMs: +median(lookupMs).toFixed(3) }));
} finally { await harness.stop(); }
