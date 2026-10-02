import { expect, test } from 'vitest';
import { RpcErrorCode, type RpcEvents } from '@boite/contracts';
import { FakeClient } from './fake-client';

test('fake diagnostic history preserves newest-first filters, strict query validation and owner-only access', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    client.emitCoreLog('info', 'first diagnostic');
    client.emitCoreLog('warn', 'second diagnostic token=private-token');
    expect((await client.call('core.logs', { limit: 2 })).map(record => record.message)).toEqual(['second diagnostic token=[redacted]', 'first diagnostic']);
    expect((await client.call('core.logs', { level: 'warn' }))[0]?.level).toBe('warn');
    expect(await client.call('core.logs', { threadId: 'absent-thread' })).toEqual([]);
    for (const params of [null, [], 'all', { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: null }, { limit: '10' }, { threadId: '' }, { threadId: 'x'.repeat(201) }, { threadId: 'bad\nthread' }, { level: 'debug' }, { level: {} }, { before: 1 }]) {
      await expect(client.call('core.logs', params as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    }
    const observed: string[] = [];
    const live: RpcEvents['core.log'][] = [];
    client.on('core.log', record => live.push(record));
    client.on('core.log', record => observed.push(record.message));
    client.becomes('agent');
    client.emitCoreLog('info', 'owner-only probe');
    expect(observed).toEqual([]);
    client.becomes('owner');
    const oauth = 'https://login.example.test/authorize?client_id=synthetic-client&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=openid&state=synthetic-state&code_challenge=synthetic-challenge';
    const message = `Open the following link: ${oauth}`;
    client.emitCoreLog('warn', `${message}\x00\x1b`, { source: 'codex', event: 'provider.output', kind: 'provider-output' });
    expect(observed).toEqual([message]);
    expect(live[0]).toMatchObject({ message, kind: 'provider-output', source: 'codex' });
    expect((await client.call('core.logs', { limit: 1 }))[0]?.message).toBe('[provider output omitted]');
    for (const principal of ['agent', 'session'] as const) {
      client.becomes(principal);
      client.emitCoreLog('warn', message, { kind: 'provider-output' });
      client.emitCoreLog('info', 'owner-only diagnostic');
      expect(observed).toEqual([message]);
      for (const threadId of ['own-thread', 'another-thread']) await expect(client.call('core.logs', { threadId })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    }
    client.becomes('owner');
    const retained = await client.call('core.logs', {});
    expect(JSON.stringify(retained)).not.toContain(oauth);
    expect(JSON.stringify(retained)).not.toContain('synthetic-state');
    expect(retained.filter(record => record.message === '[provider output omitted]')).toHaveLength(3);
    client.emitCoreLog('warn', 'x'.repeat(8000), { kind: 'provider-output' });
    expect(live.at(-1)?.message.length).toBe(4096);
    expect((await client.call('core.logs', { limit: 1 }))[0]?.message).toBe('[provider output omitted]');
  } finally { client.close(); }
});

test('fake lifecycle diagnostics are captured without a subscription and exclude the prompt', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const project = await client.call('projects.add', { path: 'C:\\fake-logs', name: 'logs' });
    const accounts = await client.call('accounts.list', {});
    const account = accounts.find(account => account.providerId === 'echo')!;
    const thread = await client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'logs' });
    const turn = await client.call('turns.start', { threadId: thread.id, prompt: 'private prompt and tokens' });
    await client.settled();
    const records = await client.call('core.logs', { threadId: thread.id });
    expect(records.map(record => record.event)).toEqual(['turn.finished', 'turn.started']);
    expect(records.every(record => record.turnId === turn.id)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('private prompt');
  } finally { client.close(); }
});
