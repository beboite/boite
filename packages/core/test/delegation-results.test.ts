import { expect, spyOn, test } from 'bun:test';
import { connect } from '../src/client.ts';
import { ServerConnection } from '../src/server.ts';
import { runCli } from '../src/cli.ts';
import { refused } from '../src/errors.ts';
import { CONVERSATION_PROFILE_ID, DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import { setDriver } from '../src/drivers/index.ts';
import type { TurnContext, TurnResult } from '../src/drivers/types.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

async function setup() {
  const h = await startTestCore();
  const pending = new Map<string, { ctx: TurnContext; finish: (text: string) => void }>();
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    const done = Promise.withResolvers<TurnResult>();
    pending.set(ctx.thread.id, { ctx, finish(text) {
      const message = ctx.emit.startMessage('assistant');
      const [first, ...rest] = text.split('\n');
      ctx.emit.part(message, 0, { type: 'text', text: first! });
      ctx.emit.part(message, 1, { type: 'tool', toolId: 'internal-tool', name: 'Bash', input: { command: 'private tool payload' }, output: 'PRIVATE_TOOL_OUTPUT', status: 'done' });
      if (rest.length) ctx.emit.part(message, 2, { type: 'text', text: rest.join('\n') });
      ctx.emit.complete(message, 'complete');
      done.resolve({ status: 'done', sessionId: null, usage: null });
    } });
    return { done: done.promise, stop() { done.resolve({ status: 'stopped', sessionId: null, usage: null }); } };
  } });
  const client = await h.connect();
  const { threadId, accountId } = await echoThread(h, client);
  const model = h.core.threads.require(threadId).model!;
  await client.call('delegation.configure', { threadId, config: { ...DEFAULT_DELEGATION_CONFIG, enabled: true, profiles: [{ id: 'worker', name: 'Worker', providerId: 'echo', accountId, model, effort: null }] } });
  const child = await client.call('delegation.spawn', { threadId, profileId: 'worker', task: 'Return text', requestId: 'child-once' });
  await waitFor(() => pending.has(child.thread.id));
  return { h, client, threadId, child, pending, async stop() { await h.stop(); restore(); } };
}

test('a child whose initial turn could not start settles individual and team waits', async () => {
  const h = await startTestCore();
  const client = await h.connect();
  const { threadId } = await echoThread(h, client);
  const start = spyOn(h.core.threads, 'startTurn').mockImplementation(() => { throw refused('fixture startup refused'); });
  try {
    await expect(client.call('delegation.spawn', { threadId, profileId: CONVERSATION_PROFILE_ID, task: 'Inspect source', requestId: 'failed-start' })).rejects.toThrow('fixture startup refused');
    const view = await client.call('delegation.get', { threadId });
    expect(view.settlement).toBe('settled');
    expect(view.agents).toHaveLength(1);
    const child = view.agents[0]!;
    expect(child).toMatchObject({ lastTurn: null, settlement: 'settled', thread: { status: 'error' } });
    for (const agentId of [child.thread.id, undefined]) {
      const result = await client.call('delegation.wait', { threadId, agentId, timeoutMs: 0 });
      expect(result).toMatchObject({ state: 'settled', timedOut: false, agents: [child] });
      expect(h.core.delegation.waits.size).toBe(0);
    }
  } finally { start.mockRestore(); await h.stop(); }
});

test('full child result pages and concurrent wait do not duplicate bounded automatic mail', async () => {
  const s = await setup();
  try {
    const params = { threadId: s.threadId, agentId: s.child.thread.id, timeoutMs: 5000 };
    const first = s.client.call('delegation.wait', params);
    const second = s.client.call('delegation.wait', params);
    await waitFor(() => s.h.core.delegation.waits.size === 2);
    const answer = 'a'.repeat(17_000) + '😀'.repeat(9_000) + '\nfinal text';
    s.pending.get(s.child.thread.id)!.finish(answer);
    const [one, two] = await Promise.all([first, second]);
    expect(one.state).toBe('result_available');
    expect(two.agents[0]!.resultRef).toEqual(one.agents[0]!.resultRef);
    const ref = one.agents[0]!.resultRef!;
    let recovered = '';
    let offset = 0;
    for (;;) {
      const page = await s.client.call('delegation.result', { threadId: s.threadId, ...ref, offset });
      expect(page.text.length).toBeLessThanOrEqual(16_000);
      recovered += page.text;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(recovered).toBe(answer);
    expect(recovered).not.toContain('PRIVATE_TOOL_OUTPUT');
    const retry = await s.client.call('delegation.wait', params);
    expect(retry.agents[0]!.resultRef).toEqual(ref);
    const letters = s.h.core.delegation.get(s.threadId).messages.filter(letter => letter.origin === 'result');
    expect(letters).toHaveLength(1);
    expect(letters[0]!.text.length).toBeLessThanOrEqual(4000);
    expect(s.h.core.delegation.waits.size).toBe(0);
  } finally { await s.stop(); }
});

test('wait timeout and disconnected waiter leave the child running and release subscriptions', async () => {
  const s = await setup();
  try {
    const params = { threadId: s.threadId, agentId: s.child.thread.id };
    const expired = await s.client.call('delegation.wait', { ...params, timeoutMs: 1 });
    expect(expired).toMatchObject({ state: 'waiting_for_children', timedOut: true });
    expect(s.h.core.journal.getTurn(s.child.lastTurn!.id)?.status).toBe('running');
    const reader = await s.h.connect();
    const interrupted = reader.call('delegation.wait', { ...params, timeoutMs: 60_000 }).catch(error => error);
    await waitFor(() => s.h.core.delegation.waits.size === 1);
    reader.close();
    await interrupted;
    await waitFor(() => s.h.core.delegation.waits.size === 0);
    expect(s.h.core.journal.getTurn(s.child.lastTurn!.id)?.status).toBe('running');
  } finally { await s.stop(); }
});

test('result ownership and bounds are enforced; child stop settles wait without repeating results', async () => {
  const s = await setup();
  try {
    const other = await echoThread(s.h, s.client, 'Unrelated');
    await expect(s.client.call('delegation.wait', { threadId: other.threadId, agentId: s.child.thread.id, timeoutMs: 0 })).rejects.toThrow('direct delegated child');
    await expect(s.client.call('delegation.result', { threadId: s.threadId, agentId: s.child.thread.id, turnId: s.child.lastTurn!.id })).rejects.toThrow('terminal turn');
    const waiting = s.client.call('delegation.wait', { threadId: s.threadId, agentId: s.child.thread.id, timeoutMs: 5000 });
    await s.client.call('delegation.stop', { threadId: s.threadId, agentId: s.child.thread.id });
    const ended = await waiting;
    expect(ended.agents[0]!.lastTurn?.status).toBe('stopped');
    await expect(s.client.call('delegation.result', { threadId: s.threadId, agentId: s.child.thread.id, turnId: ended.agents[0]!.lastTurn!.id, limit: 16_001 })).rejects.toThrow('limit');
    await expect(s.client.call('delegation.result', { threadId: other.threadId, agentId: s.child.thread.id, turnId: ended.agents[0]!.lastTurn!.id })).rejects.toThrow('direct delegated child');
  } finally { await s.stop(); }
});

test('core shutdown releases an event-driven waiter', async () => {
  const s = await setup();
  try {
    const held = s.client.call('delegation.wait', { threadId: s.threadId, agentId: s.child.thread.id }).catch(error => error);
    await waitFor(() => s.h.core.delegation.waits.size === 1);
    await s.h.core.drain();
    expect((await held).message).toContain('stopping');
    expect(s.h.core.delegation.waits.size).toBe(0);
  } finally { await s.stop(); }
});


test('team wait includes unfinished children and paired result reads retain exact turn ownership', async () => {
  const s = await setup();
  let phone: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    let finished = false;
    const team = s.client.call('delegation.wait', { threadId: s.threadId, timeoutMs: 5000 }).then(result => { finished = true; return result; });
    await waitFor(() => s.h.core.delegation.waits.size === 1);
    const sibling = await s.client.call('delegation.spawn', { threadId: s.threadId, profileId: 'worker', task: 'Second child', requestId: 'second-child' });
    s.pending.get(s.child.thread.id)!.finish('First result');
    await Bun.sleep(10);
    expect(finished).toBe(false);
    s.pending.get(sibling.thread.id)!.finish('Second result');
    const results = await team;
    expect(results.state).toBe('settled');
    expect(results.agents).toHaveLength(2);
    const { grant } = await s.client.call('pairing.grant', {});
    phone = await connect(s.h.url, '', { grant, client: { name: 'phone', version: 'test' } });
    const ref = results.agents[0]!.resultRef!;
    expect((await phone.call('delegation.result', { threadId: s.threadId, ...ref })).text).toBe('First result');
    await expect(phone.call('delegation.result', { threadId: s.threadId, agentId: s.child.thread.id, turnId: results.agents[1]!.resultRef!.turnId })).rejects.toThrow('terminal turn');
    expect((await phone.call('delegation.wait', { threadId: s.threadId, timeoutMs: 0 })).state).toBe('settled');
  } finally { phone?.close(); await s.stop(); }
});

test('CLI delegate wait/result returns references and bounded text; closing callbacks cannot block cleanup', async () => {
  const s = await setup();
  try {
    s.pending.get(s.child.thread.id)!.finish('CLI full result');
    await waitFor(() => s.h.core.journal.getTurn(s.child.lastTurn!.id)?.status === 'done');
    const output: string[] = [];
    const io = { cwd: s.h.dataDir, env: { BOITE_THREAD_ID: s.threadId, BOITE_CORE_URL: s.h.url, BOITE_AGENT_TOKEN: s.h.core.agents.tokenFor(s.threadId) }, out: (text: string) => output.push(text), err: (text: string) => output.push(text) };
    expect(await runCli(['--data-dir', s.h.dataDir, '--thread', s.threadId, 'delegate', 'wait', s.child.thread.id, '--timeout', '0', '--json'], io)).toBe(0);
    expect(JSON.parse(output.pop()!).state).toBe('result_available');
    expect(await runCli(['--data-dir', s.h.dataDir, '--thread', s.threadId, 'delegate', 'result', s.child.thread.id, s.child.lastTurn!.id, '--json'], io)).toBe(0);
    expect(JSON.parse(output.pop()!).text).toBe('CLI full result');
    const connection = new ServerConnection(s.h.core);
    let released = 0;
    connection.onClose(() => { throw new Error('unrelated failed cleanup'); });
    connection.onClose(() => released++);
    connection.close(1000);
    connection.onClose(() => released++);
    expect(released).toBe(2);
  } finally { await s.stop(); }
});
