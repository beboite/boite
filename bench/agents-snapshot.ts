/** An agent snapshot and a session lookup over a long persistent-agent history, on a temporary core.
 * Each step adds finished work, its run with 20 KB of frozen instructions, a message and a memory;
 * every tenth step adds a session in another context.
 * Run: bun run bench/agents-snapshot.ts [steps]
 */
import { startTestCore } from '../packages/core/test/harness.ts';

const steps = Number(process.argv[2] ?? 2000);
const harness = await startTestCore();
try {
  const client = await harness.connect();
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name: 'Bench', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory'], accountIntegration: 'provider' } });
  const scope = { kind: 'agent' as const, id: agent.id };
  const r = harness.core.workforce.records;
  r.transaction(() => {
    for (let i = 0; i < steps; i++) {
      const work = r.create('work', { agentId: agent.id, scope, taskId: null, taskGeneration: null, messageId: null, episodeId: `episode-${i}`, prompt: `step ${i}`, status: 'done', error: null, runId: null, notBefore: 0 });
      r.create('run', { workId: work.id, agentId: agent.id, threadId: `thread-${i}`, turnId: null, execution: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, profileRevision: 1, context: { memoryIds: [], messageIds: [], resources: [], instructions: 'x'.repeat(20_000) }, status: 'done', startedAt: 1, finishedAt: 2, actualExecution: null });
      r.create('message', { scope, senderId: null, text: `message ${i}`, recipientIds: [], replyTo: null, episodeId: `episode-${i}`, sourceRunId: null });
      r.create('memory', { scope, title: `memory ${i}`, text: 'kept', sourceScopes: [scope], sourceRunId: null, expiresAt: null });
      if (i % 10 === 0) r.create('session', { agentId: agent.id, scope: { kind: 'mission', id: `mission-${i}` }, threadId: `session-thread-${i}` });
    }
  });
  // One real session thread among the thousands of recorded ones: the lookup has to find it.
  const session = r.create('session', { agentId: agent.id, scope, threadId: '' });
  const thread = harness.core.threads.createAgentSession(agent, session.id, harness.dataDir);
  r.update('session', session.id, session.revision, { ...session, threadId: thread.id });
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]!;
  const snapshotMs: number[] = [], sessionMs: number[] = [];
  let bytes = 0;
  for (let run = 0; run < 7; run++) {
    let start = performance.now();
    const snapshot = await client.call('agents.snapshot', {});
    if (run > 0) snapshotMs.push(performance.now() - start);
    bytes = JSON.stringify(snapshot).length;
    start = performance.now();
    for (let i = 0; i < 100; i++) harness.core.workforce.session(thread.id);
    if (run > 0) sessionMs.push((performance.now() - start) / 100);
  }
  console.log(JSON.stringify({ steps, snapshotBytes: bytes, snapshotMedianMs: +median(snapshotMs).toFixed(2), sessionLookupMedianMs: +median(sessionMs).toFixed(3) }));
} finally { await harness.stop(); }
