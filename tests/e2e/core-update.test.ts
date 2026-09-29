import { expect, test } from 'bun:test';
import { connect } from '../../packages/core/src/client.ts';
import { startCore } from './lib/core.ts';

test('a real core finishes its turn, admits an update, and restarts with the completed journal', async () => {
  const core = await startCore();
  const client = await connect(core.url, core.token);
  const ask = () => fetch(`${core.url}/shutdown-if-idle?pid=${client.core.pid}`, {
    method: 'POST', headers: { authorization: `Bearer ${core.token}` },
  });
  try {
    const project = await client.call('projects.add', { path: core.dataDir, name: 'Update fixture' });
    const account = (await client.call('accounts.list', {})).find(a => a.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'Finish before updating' });
    await client.call('threads.subscribe', { threadId: thread.id });
    const finished = client.next('turn.finished', turn => turn.threadId === thread.id);
    void finished.catch(() => undefined);
    await client.call('turns.start', { threadId: thread.id, prompt: '[sleep:400] preserved answer' });
    expect((await ask()).status).toBe(409);
    expect((await finished).status).toBe('done');
    // The finish event precedes scheduler cleanup; busy is still a safe refusal.
    let response: Response;
    const deadline = Date.now() + 5_000;
    do {
      response = await ask();
      if (response.status === 409) await Bun.sleep(20);
    } while (response.status === 409 && Date.now() < deadline);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, pid: client.core.pid });
    expect(await Promise.race([core.exited, Bun.sleep(15_000).then(() => 'did not exit')])).toBe(0);
    const next = await startCore({ dataDir: core.dataDir });
    const reconnected = await connect(next.url, next.token);
    try {
      const saved = await reconnected.call('threads.get', { threadId: thread.id });
      expect(saved.turns).toHaveLength(1);
      expect(saved.turns[0]!.status).toBe('done');
      expect(saved.turns[0]!.error).toBeNull();
      expect(saved.messages.some(message => message.role === 'assistant' && message.state === 'complete')).toBe(true);
    } finally { reconnected.close(); await next.stop({ keepDataDir: true }); }
  } finally { client.close(); await core.stop(); }
}, 45_000);
