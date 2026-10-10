import { expect, test } from 'vitest';
import { FakeClient } from './fake-client';
import { agentProgress, teamLaunches, teamProgress } from './delegation-progress';

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

test('each launch gets its own card after the message it followed, and older history waits for its page', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  try {
    await client.connect();
    const [first, second] = (await client.call('delegation.get', { threadId: 't-trace' })).agents;
    const at = (agent: typeof first, createdAt: number) => ({ ...agent!, thread: { ...agent!.thread, createdAt } });
    const messages = [{ id: 'm1', createdAt: 100 }, { id: 'm2', createdAt: 200 }, { id: 'm3', createdAt: 300 }];
    const early = at(first, 150);
    const late = [at(second, 250), at(first, 260)];
    const launches = teamLaunches([late[1]!, early, late[0]!], messages, false);
    expect(launches.map(launch => [launch.id, launch.createdAt, launch.agents.length])).toEqual([['delegation:m1', 150, 1], ['delegation:m2', 250, 2]]);
    const before = at(second, 50);
    expect(teamLaunches([before, early], messages, false).map(launch => launch.id)).toEqual(['delegation:start', 'delegation:m1']);
    expect(teamLaunches([before, early], messages, true).map(launch => launch.id)).toEqual(['delegation:m1']);
  } finally { client.close(); }
});
