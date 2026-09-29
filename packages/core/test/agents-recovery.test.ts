import { expect, test } from 'bun:test';
import { Core } from '../src/core.ts';
import { connect } from '../src/client.ts';
import { startTestCore, removeDir, waitFor, type TestCore } from './harness.ts';

async function startSleepingAgent(h: TestCore) {
  const client = await h.connect();
  const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
  const agent = await client.call('agents.profile.save', { value: { name: 'Worker', domain: '', instructions: '', avatar: '', selection: { providerId: 'echo', accountId: account.id, model: null, effort: null, permissionMode: 'default' }, status: 'active', tools: ['messages', 'memory', 'missions', 'decisions'], accountIntegration: 'provider' } });
  await client.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, recipientIds: [agent.id], text: '[sleep:60000] inspect workspace', requestId: 'recovery_001' });
  await waitFor(() => h.core.workforce.records.list('run').some(r => r.status === 'running'));
  const run = h.core.workforce.records.list('run')[0]!;
  return { client, agent, run };
}

async function crash(h: TestCore) {
  await h.core.agentRuntime.close();
  h.core.journal.close();
  await h.server.stop();
  await h.core.close();
}

test('a started execution is reconciled after a restart instead of replayed', async () => {
  const h = await startTestCore();
  const { client, run } = await startSleepingAgent(h);
  client.close();
  await crash(h);
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    const snapshot = next.workforce.snapshot();
    expect(snapshot.work[0]?.status).toBe('interrupted');
    expect(snapshot.runs[0]?.status).toBe('interrupted');
    expect(snapshot.runs).toHaveLength(1);
    expect(next.threads.get(run.threadId).turns[0]?.status).toBe('error');
    const work = snapshot.work[0]!;
    expect(() => next.workforce.control({ workId: work.id, expectedRevision: work.revision, action: 'resume' })).toThrow('reconciliation');
    next.workforce.setLimits({ ...snapshot.limits, paused: true });
    const resumed = next.workforce.control({ workId: work.id, expectedRevision: work.revision, action: 'reconcile', note: 'Workspace inspected. Continue only the unfinished checks.' });
    expect(resumed.status).toBe('pending');
    expect(resumed.runId).toBeNull();
  } finally { await next.close(); await removeDir(h.dataDir); }
});

test('a durable decision survives restart, frees execution, and accepts only one answer', async () => {
  const h = await startTestCore();
  const { client, run } = await startSleepingAgent(h);
  const token = h.core.agents.tokenFor(run.threadId);
  const agentClient = await connect(h.url, token);
  const request = { threadId: run.threadId, prompt: 'Which direction?', options: ['Keep', 'Change'], requestId: 'decision_001' };
  const decision = await agentClient.call('agents.decision.request', request);
  expect(await agentClient.call('agents.decision.request', request)).toEqual(decision);
  await waitFor(() => h.core.scheduler.state().running.length === 0);
  expect(h.core.workforce.records.get('work', run.workId).status).toBe('waiting');
  agentClient.close(); client.close(); await crash(h);
  const next = new Core({ dataDir: h.dataDir, token: h.token });
  try {
    next.workforce.setLimits({ ...next.workforce.limits(), paused: true });
    expect(next.workforce.snapshot().decisions[0]?.status).toBe('pending');
    const answer = { decisionId: decision.id, expectedRevision: decision.revision, answer: 'Change' };
    next.workforce.answerDecision(answer);
    expect(() => next.workforce.answerDecision(answer)).toThrow('already answered');
    expect(next.workforce.snapshot().work.map(w => w.status)).toEqual(['done', 'pending']);
    expect(next.workforce.snapshot().work[1]?.prompt).toContain('User answer: Change');
  } finally { await next.close(); await removeDir(h.dataDir); }
});
