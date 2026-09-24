import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';
import { agentProgress, teamProgress } from './delegation-progress';

test('only successful finished turns count as completed, with active status taking precedence', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  try {
    await client.connect();
    const { agents } = await client.call('delegation.get', { threadId: 't-trace' });
    const [running, done] = agents;
    expect(teamProgress(agents)).toMatchObject({ active: true, completed: 1, failed: 0, stopped: 0, finishedAt: null });
    expect(agentProgress({ ...running!, lastTurn: done!.lastTurn }).status).toBe('running');
    const stopped = { ...done!, lastTurn: { ...done!.lastTurn!, status: 'stopped' as const } };
    const failed = { ...done!, lastTurn: { ...done!.lastTurn!, status: 'error' as const } };
    const unknown = { ...done!, lastTurn: null };
    expect(teamProgress([done!, stopped, failed, unknown])).toMatchObject({ active: false, completed: 1, failed: 1, stopped: 1, finishedAt: null });
    expect(teamProgress([done!, stopped]).finishedAt).toBe(done!.lastTurn!.finishedAt);
    expect(teamProgress([])).toMatchObject({ active: false, startedAt: null, finishedAt: null, completed: 0 });
  } finally { client.close(); }
});
