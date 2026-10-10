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
    for (const params of [null, [], 'all', { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: null }, { limit: '10' }, { threadId: '' }, { threadId: 'x'.repeat(201) }, { threadId: 'bad\nthread' }, { level: 'trace' }, { level: {} }, { minLevel: 'all' }, { origin: 'agent' }, { since: -1 }, { until: 'now' }, { search: '' }, { anonymize: 'yes' }, { before: 1 }]) {
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

test('fake core.logs answers the level, origin, time and text filters, and anonymizes on request', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const project = await client.call('projects.add', { path: 'C:\\Users\\you\\code\\secret-garden', name: 'secret-garden' });
    client.emitCoreLog('debug', 'detail nobody reads');
    client.emitCoreLog('warn', `Build slowed down in ${project.path}\\target`, { source: 'cargo', event: 'build.slow', durationMs: 6400, data: { jobs: 8 } });
    const warnings = await client.call('core.logs', { minLevel: 'warn', limit: 1000 });
    expect(warnings.every(record => record.level === 'warn' || record.level === 'error')).toBe(true);
    expect(warnings[0]).toMatchObject({ source: 'cargo', event: 'build.slow', durationMs: 6400, data: { jobs: 8 } });
    expect((await client.call('core.logs', { minLevel: 'debug', limit: 1000 })).some(record => record.message === 'detail nobody reads')).toBe(true);
    expect((await client.call('core.logs', { limit: 1000 })).some(record => record.level === 'debug')).toBe(true);
    expect((await client.call('core.logs', { origin: 'ui' })).every(record => record.origin === 'ui')).toBe(true);
    expect((await client.call('core.logs', { origin: 'shell' })).length).toBeGreaterThan(0);
    expect((await client.call('core.logs', { search: 'SLOWED' })).map(record => record.event)).toEqual(['build.slow']);
    expect(await client.call('core.logs', { since: Date.now() + 60_000 })).toEqual([]);
    const plain = (await client.call('core.logs', { search: 'slowed' }))[0]!;
    expect(plain.message).toContain('secret-garden');
    const hidden = (await client.call('core.logs', { search: 'slowed', anonymize: true }))[0]!;
    expect(hidden.message).not.toContain('secret-garden');
    expect(hidden.message).toMatch(/<project:[0-9a-f]{6}>/);
  } finally { client.close(); }
});

test('fake diagnostics: summary, export and issue for the owner; report for the owner and a paired device; agents only while allowed', async () => {
  const client = new FakeClient({ delayMs: 0 });
  await client.connect();
  try {
    const summary = await client.call('diagnostics.summary', {});
    expect(summary.environment.version).toBe('2.0.0-beta.1');
    expect(summary.counts.error).toBeGreaterThan(0);
    expect(summary.problems[0]?.level).toBe('error');
    expect(summary.logFiles.map(file => file.name)).toContain('core.0.ndjson');

    const exported = await client.call('diagnostics.export', {});
    expect(exported.name).toMatch(/^boite-diagnostics-\d{8}-\d{6}\.txt$/);
    expect(exported.text).toContain('## Timeline');
    expect(exported.bytes).toBe(new TextEncoder().encode(exported.text).length);
    for (const params of [null, { limit: 0 }, { limit: 20_001 }, { limit: 1.5 }]) await expect(client.call('diagnostics.export', params as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });

    const draft = await client.call('diagnostics.issue', { title: 'The window froze', description: 'It froze while C:\\Users\\you\\code was open.' });
    expect(draft).toMatchObject({ repository: 'beboite/boite', url: null, gh: 'missing', error: null });
    expect(draft.body).toContain('### What happened');
    expect(draft.body).not.toContain('C:\\Users\\you');
    expect(draft.prefillUrl.startsWith('https://github.com/beboite/boite/issues/new?')).toBe(true);
    expect(draft.exportPath).toMatch(/boite-diagnostics-.*\.txt$/);
    const withoutLogs = await client.call('diagnostics.issue', { title: 'The window froze', description: 'Again.', includeLogs: false });
    expect(withoutLogs.exportPath).toBeNull();
    const submitted = await client.call('diagnostics.issue', { title: 'The window froze', description: 'Again.', submit: true });
    expect(submitted.url).toBeNull();
    expect(submitted.error).toMatch(/not installed/);
    for (const params of [{ title: 'abc', description: 'x' }, { title: 'one\ntwo', description: 'x' }, { title: 'Long enough', description: '' }, { title: 'Long enough', description: 'x'.repeat(20_001) }]) {
      await expect(client.call('diagnostics.issue', params)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    }

    expect(await client.call('diagnostics.report', { records: [{ level: 'error', at: Date.now(), source: 'window', event: 'ui.error', message: 'The interface hit an error: boom', data: { stack: 'at x' } }] })).toEqual({ accepted: 1 });
    const reported = (await client.call('core.logs', { origin: 'ui', limit: 1 }))[0];
    expect(reported).toMatchObject({ origin: 'ui', event: 'ui.error', data: { stack: 'at x', client: 'owner', remote: false } });
    for (const params of [{}, { records: [] }, { records: Array.from({ length: 51 }, () => ({ level: 'info', at: 1, source: 's', event: 'e', message: 'm' })) }, { records: [{ level: 'loud', at: 1, source: 's', event: 'e', message: 'm' }] }]) {
      await expect(client.call('diagnostics.report', params as never)).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams });
    }

    client.becomes('session');
    expect(await client.call('diagnostics.report', { records: [{ level: 'warn', at: Date.now(), source: 'connection', event: 'ui.reconnected', message: 'Back after 3 s', durationMs: 3000 }] })).toEqual({ accepted: 1 });
    for (const method of ['diagnostics.summary', 'diagnostics.export', 'diagnostics.logs', 'core.logs'] as const) await expect(client.call(method, {} as never)).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('diagnostics.issue', { title: 'The window froze', description: 'x' })).rejects.toMatchObject({ code: RpcErrorCode.Refused });

    client.becomes('agent');
    await expect(client.call('diagnostics.report', { records: [{ level: 'info', at: 1, source: 's', event: 'e', message: 'm' }] })).rejects.toMatchObject({ code: RpcErrorCode.Refused });
    await expect(client.call('diagnostics.summary', {})).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: expect.stringMatching(/its own thread/) });
    client.becomes('owner');
    await client.call('settings.set', { agentLogAccess: false });
    client.becomes('agent');
    await expect(client.call('diagnostics.logs', { limit: 10 })).rejects.toMatchObject({ code: RpcErrorCode.Refused, message: expect.stringMatching(/turned off agent access/) });
    client.becomes('owner');
    expect((await client.call('diagnostics.logs', { limit: 5, minLevel: 'error' })).every(record => record.level === 'error')).toBe(true);
  } finally { client.close(); }
});
