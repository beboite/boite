import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCoreLogText, RpcErrorCode, type ProcessRecord, type RpcEvents, type Turn } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { DiagnosticLogs, LOG_FILE_COUNT, LOG_MESSAGE_CHARS, redactLogText } from '../src/logs.ts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { withLogDiagnostic } from '../src/log-errors.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';

function temporary(): string { return mkdtempSync(join(tmpdir(), 'boite-logs-')); }

const turn: Turn = { id: 'turn_test', threadId: 'thr_test', status: 'running', queuedAt: 1, startedAt: 2, finishedAt: null, usage: null, error: null };
const proc: ProcessRecord = { pid: 123, parentPid: null, threadId: turn.threadId, exe: '/secret/provider', commandLine: 'provider --prompt private-prompt --token private-token', startedAt: 3, exitedAt: null, exitCode: null, cpuMs: null, peakMemoryBytes: null, ioBytes: null };

describe('bounded persistent diagnostics', () => {
  test('long ordinary diagnostic words do not block normalization or expose credentials before truncation', () => {
    for (const word of ['a'.repeat(16_384), 'long-diagnostic-'.repeat(1200)]) {
      const started = performance.now();
      const result = normalizeCoreLogText(`token=synthetic-private https://user:pass@example.test/?key=synthetic-query ${word}`);
      expect(performance.now() - started).toBeLessThan(500);
      expect(result).not.toMatch(/synthetic-private|user:pass|synthetic-query/);
      expect(result.length).toBe(4096);
      expect(normalizeCoreLogText(result)).toBe(result);
    }
    const known = 'a-known-credential-crossing-the-limit';
    expect(normalizeCoreLogText('x'.repeat(4080) + known, [known])).not.toContain(known.slice(0, 16));
    for (const input of ['service-api-key=synthetic-private-value', 'user_api_key={"value":"synthetic-private-value"}', 'payload_content="synthetic-private-value"']) {
      expect(normalizeCoreLogText(input)).not.toContain('synthetic-private-value');
    }
  });

  test('redacts credentials and payload fields before bounding, without losing the technical cause', async () => {
    const directory = temporary();
    const secret = 'core-secret';
    const logs = new DiagnosticLogs(directory, [secret]);
    const bus = new Bus();
    logs.attach(bus);
    const observed: string[] = [];
    const live: RpcEvents['core.log'][] = [];
    bus.onAny((name, payload) => { if (name === 'core.log') { const log = payload as RpcEvents['core.log']; observed.push(log.message); live.push(log); } });
    const message = 'SQLite write failed: disk full core-secret Authorization: Bearer auth-secret\n' +
      'token="token secret" grant=grant-secret api_key=api-secret prompt="private prompt" attachments="private attachment" params="private rpc" ' +
      'https://url-user:url-password@example.test/failure?access_token=query-secret&unknown=extra-secret#fragment-secret ' +
      'wss://ws-user:ws-password@example.test/rpc?key=socket-secret ' + 'z'.repeat(8000);
    try {
      bus.emit('core.log', { level: 'error', message, at: 1, source: 'x'.repeat(1000), threadId: 'thr_test' });
      const [record] = await logs.query({ level: 'error', threadId: 'thr_test' });
      expect(record?.message).toContain('SQLite write failed: disk full');
      expect(record?.message.length).toBe(LOG_MESSAGE_CHARS);
      expect(record?.source.length).toBe(200);
      for (const value of ['core-secret', 'auth-secret', 'token secret', 'grant-secret', 'api-secret', 'private prompt', 'private attachment', 'private rpc', 'url-user', 'url-password', 'query-secret', 'extra-secret', 'fragment-secret', 'ws-user', 'ws-password', 'socket-secret']) {
        expect(JSON.stringify(record)).not.toContain(value);
        expect(observed.join()).not.toContain(value);
        expect(readFileSync(join(directory, 'logs', 'core.0.ndjson'), 'utf8')).not.toContain(value);
      }
      bus.emit('core.log', { level: 'warn', at: 2, message: 'provider echoed a private prompt', source: 'codex', event: 'provider.output', kind: 'provider-output' });
      expect((await logs.query({ limit: 1 }))[0]?.message).toBe('[provider output omitted]');
      expect(observed.at(-1)).toBe('provider echoed a private prompt');
      expect(live.at(-1)?.kind).toBe('provider-output');
      bus.emit('core.log', { level: 'warn', at: 3, message: 'codex agent: protocol error -32000: disk full', source: 'codex' });
      expect((await logs.query({ limit: 1 }))[0]?.message).toBe('codex agent: protocol error -32000: disk full');
      expect(redactLogText(redactLogText(message, [secret]), [secret])).toBe(redactLogText(message, [secret]));
      expect(redactLogText('failure code -32000 params={"prompt":"secret text","parts":["private tail"]}')).toBe('failure code -32000 params=[redacted]');
    } finally { bus.dispose(); await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('rotates within the byte limit, flushes on close and reads older runs lazily after restart', async () => {
    const directory = temporary();
    const logs = new DiagnosticLogs(directory, [], undefined, 1024);
    const oldRun = logs.runId;
    try {
      for (let index = 0; index < 20; index += 1) logs.record('info', `entry ${index} ${'x'.repeat(180)}`, { source: 'test', event: 'rotation' }, index);
      await logs.close();
      const files = readdirSync(join(directory, 'logs'));
      expect(files.length).toBe(LOG_FILE_COUNT);
      for (const file of files) {
        expect(statSync(join(directory, 'logs', file)).size).toBeLessThanOrEqual(1024);
        if (process.platform !== 'win32') expect(statSync(join(directory, 'logs', file)).mode & 0o777).toBe(0o600);
      }
      if (process.platform !== 'win32') expect(statSync(join(directory, 'logs')).mode & 0o777).toBe(0o700);
      const restarted = new DiagnosticLogs(directory, [], undefined, 1024);
      try {
        const records = await restarted.query({ limit: 200 });
        expect(records[0]?.message).toStartWith('entry 19');
        expect(records.every(record => record.runId === oldRun)).toBe(true);
        expect(records.length).toBeLessThan(20);
        restarted.record('warn', 'new run', { source: 'test', event: 'restart' }, 100);
        expect((await restarted.query({ limit: 2 })).map(record => record.runId)).toEqual([restarted.runId, oldRun]);
      } finally { await restarted.close(); }
    } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('records only committed lifecycle metadata, without payloads or streamed tokens', async () => {
    const directory = temporary();
    const logs = new DiagnosticLogs(directory);
    const bus = new Bus(); logs.attach(bus);
    try {
      expect(() => bus.afterCommit(() => { bus.emit('turn.started', { ...turn, id: 'rolled-back' }); throw new Error('rollback'); })).toThrow('rollback');
      bus.emit('scheduler.updated', { running: [], queued: [{ threadId: turn.threadId, turnId: turn.id, position: 0, queuedAt: 1 }] });
      bus.emit('scheduler.updated', { running: [], queued: [{ threadId: turn.threadId, turnId: turn.id, position: 0, queuedAt: 1 }] });
      bus.afterCommit(() => { bus.emit('turn.started', turn); bus.emit('process.started', proc); });
      bus.emit('message.delta', { threadId: turn.threadId, messageId: 'msg_test', partIndex: 0, text: 'private streamed text' });
      bus.afterCommit(() => {
        bus.emit('turn.finished', { ...turn, status: 'error', finishedAt: 4, error: 'private provider result' });
        bus.emit('process.exited', { ...proc, exitedAt: 5, exitCode: 0 });
      });
      const records = await logs.query({ threadId: turn.threadId });
      expect(records.map(record => record.event)).toEqual(['process.exited', 'turn.finished', 'process.started', 'turn.started', 'turn.queued']);
      expect(records.every(record => record.turnId === turn.id)).toBe(true);
      expect(records[1]?.level).toBe('error');
      expect(JSON.stringify(records)).not.toMatch(/private|rolled-back|--prompt|provider/);
    } finally { bus.dispose(); await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('initialization and append failures report once, cannot recurse or interrupt app work, and still permit recent queries', async () => {
    for (const blockInitialization of [true, false]) {
      const directory = temporary();
      if (blockInitialization) writeFileSync(join(directory, 'logs'), 'a file blocks the directory');
      const reports: string[] = [];
      const logs = new DiagnosticLogs(directory, [], message => { reports.push(message); throw new Error('reporter also failed'); });
      try {
        if (!blockInitialization) { await logs.query({}); mkdirSync(join(directory, 'logs', 'core.0.ndjson')); }
        logs.record('info', 'app continues');
        expect((await logs.query({}))[0]?.message).toBe('app continues');
        logs.record('warn', 'still running');
        expect((await logs.query({}))[0]?.message).toBe('still running');
        expect(reports).toHaveLength(1);
        expect(reports[0]).toContain('diagnostic logs unavailable');
      } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
    }
  });

  test('restart tolerates a partial final NDJSON line and restores private modes', async () => {
    const directory = temporary();
    const first = new DiagnosticLogs(directory);
    first.record('info', 'before interrupted write'); await first.close();
    const file = join(directory, 'logs', 'core.0.ndjson');
    writeFileSync(file, readFileSync(file, 'utf8') + '{"partial":');
    if (process.platform !== 'win32') chmodSync(file, 0o644);
    const second = new DiagnosticLogs(directory);
    try {
      expect((await second.query({}))[0]?.message).toBe('before interrupted write');
      if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    } finally { await second.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a burst cannot grow the pending queue and persists an explicit loss count', async () => {
    const directory = temporary();
    const reports: string[] = [];
    const logs = new DiagnosticLogs(directory, [], message => reports.push(message));
    try {
      for (let index = 0; index < 300; index += 1) logs.record('info', `burst ${index}`);
      const records = await logs.query({ limit: 2 });
      expect(records[0]).toMatchObject({ event: 'logs.dropped', level: 'warn', message: '44 diagnostics were not persisted because the pending buffer was full' });
      expect(records[1]?.message).toBe('burst 299');
      expect(reports).toHaveLength(1);
      await logs.close();
      const restarted = new DiagnosticLogs(directory);
      try {
        const retained = await restarted.query({ limit: 2 });
        expect(retained[0]?.event).toBe('logs.dropped');
        expect(retained[1]?.message).toBe('burst 255');
      } finally { await restarted.close(); }
    } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

const invalidQueries: unknown[] = [null, [], 'all', { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: null }, { limit: '10' }, { threadId: '' }, { threadId: 'x'.repeat(201) }, { threadId: 'bad\nthread' }, { level: 'debug' }, { level: {} }, { before: 1 }];

test('real logs queries enforce strict validation, newest-first filters and owner-only access', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    harness.core.bus.emit('core.log', { at: 1, level: 'info', message: 'first diagnostic' });
    harness.core.bus.emit('core.log', { at: 2, level: 'warn', message: 'second diagnostic' });
    for (const client of [owner]) {
      expect((await client.call('core.logs', { limit: 2 })).map(record => record.message)).toEqual(['second diagnostic', 'first diagnostic']);
      expect((await client.call('core.logs', { level: 'warn' }))[0]?.message).toBe('second diagnostic');
      expect(await client.call('core.logs', { threadId: 'absent-thread' })).toEqual([]);
      for (const params of invalidQueries) {
        try { await client.call('core.logs', params as never); throw new Error('invalid query accepted'); }
        catch (error) { expect((error as { rpc: { code: number } }).rpc.code).toBe(RpcErrorCode.InvalidParams); }
      }
    }
    const agent = await connect(harness.url, harness.core.agents.tokenFor(threadId));
    const { grant } = await owner.call('pairing.grant', {});
    const phone = await connect(harness.url, '', { grant });
    try {
      const live: RpcEvents['core.log'][] = [], agentLogs: RpcEvents['core.log'][] = [], phoneLogs: RpcEvents['core.log'][] = [];
      owner.on('core.log', log => live.push(log));
      agent.on('core.log', log => agentLogs.push(log));
      phone.on('core.log', log => phoneLogs.push(log));
      const oauth = 'https://login.example.test/authorize?client_id=synthetic-client&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback&scope=openid&state=synthetic-state&code_challenge=synthetic-challenge&nonce=synthetic-nonce';
      const message = `Open the following link: ${oauth}\ncore handle ${harness.token}\x00\x1b`;
      harness.core.bus.emit('core.log', { level: 'warn', at: 3, message, source: 'acp', event: 'provider.output', kind: 'provider-output', threadId });
      const [retained] = await owner.call('core.logs', { limit: 1 });
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ kind: 'provider-output', source: 'acp', threadId, message: `Open the following link: ${oauth}\ncore handle [redacted]` });
      expect(live[0]?.message).not.toContain(harness.token);
      expect(retained).toMatchObject({ message: '[provider output omitted]', threadId, source: 'acp', event: 'provider.output' });
      const persisted = readFileSync(join(harness.dataDir, 'logs', 'core.0.ndjson'), 'utf8');
      expect(persisted).not.toContain(oauth);
      expect(persisted).not.toContain('synthetic-state');
      for (const client of [agent, phone]) for (const id of [threadId, 'another-thread']) await expect(client.call('core.logs', { threadId: id })).rejects.toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
      expect(agentLogs).toEqual([]);
      expect(phoneLogs).toEqual([]);
      // Even a long output stays usable and bounded for its owner, while retention stays fixed.
      const known = harness.token;
      harness.core.bus.emit('core.log', { level: 'warn', at: 4, message: 'x'.repeat(4090) + known + 'y'.repeat(8000), kind: 'provider-output' });
      expect((await owner.call('core.logs', { limit: 1 }))[0]?.message).toBe('[provider output omitted]');
      expect(live.at(-1)?.message.length).toBe(LOG_MESSAGE_CHARS);
      expect(live.at(-1)?.message).not.toContain(known.slice(0, 12));
    } finally { agent.close(); phone.close(); }
  } finally { await harness.stop(); }
});

test('unexpected RPC causes persist with request correlation while clients receive only the generic failure', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const logEvents: string[] = [];
    owner.on('core.log', log => logEvents.push(log.message));
    harness.core.router.register('projects.list', () => { throw new Error(`SQLite failed token=${harness.token}`, { cause: new Error('disk full') }); });
    await expect(owner.call('projects.list', {})).rejects.toMatchObject({ rpc: { code: RpcErrorCode.Internal, message: 'Something went wrong. Try again.' } });
    const [record] = await owner.call('core.logs', { level: 'error' });
    expect(record).toMatchObject({ source: 'rpc', event: 'rpc.failed' });
    expect(record?.requestId).toBeString();
    expect(record?.message).toContain('SQLite failed');
    expect(record?.message).toContain('caused by: disk full');
    expect(record?.message).not.toContain(harness.token);
    expect(logEvents).toEqual([]);
  } finally { await harness.stop(); }
});

test('known stderr remains in the existing turn error while its fixed diagnostic and correlation are retained', async () => {
  const harness = await startTestCore();
  const raw = 'the test agent exited with code 17: private prompt echoed to stderr';
  const diagnostic = 'the test agent exited with code 17';
  const restore = setDriver('echo', { protocol: 'echo', startTurn(ctx) {
    ctx.log('warn', 'private prompt echoed to stderr', { kind: 'provider-output', event: 'provider.output' });
    return { done: Promise.resolve({ status: 'error', sessionId: null, usage: null, error: raw, diagnosticError: diagnostic }), stop: () => undefined };
  } });
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const turn = await owner.call('turns.start', { threadId, prompt: 'private prompt' });
    await waitFor(() => harness.core.journal.listTurns(threadId).some(saved => saved.id === turn.id && saved.status === 'error'));
    expect(harness.core.journal.listTurns(threadId)[0]?.error).toBe(raw);
    const records = await owner.call('core.logs', { threadId });
    expect(JSON.stringify(records)).not.toContain('private prompt');
    expect(records.find(record => record.event === 'turn.failed')).toMatchObject({ source: 'echo', threadId, turnId: turn.id, message: `turn ${turn.id} failed: ${diagnostic}` });
    expect(records.find(record => record.event === 'provider.output')?.message).toBe('[provider output omitted]');
    const error = withLogDiagnostic(new Error(raw), diagnostic);
    expect(error.message).toBe(raw);
    harness.core.router.register('projects.list', () => { throw error; });
    await expect(owner.call('projects.list', {})).rejects.toThrow('Something went wrong. Try again.');
    expect((await owner.call('core.logs', { level: 'error', limit: 1 }))[0]?.message).toBe(`projects.list failed: ${diagnostic}`);
  } finally { restore(); await harness.stop(); }
});

test('real echo turns capture queued, started, finished lifecycle and CLI reads owner logs with the established printer', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    const turn = await owner.call('turns.start', { threadId, prompt: 'private prompt should never be diagnostic' });
    await waitFor(() => harness.core.journal.listTurns(threadId).some(saved => saved.id === turn.id && saved.status === 'done'));
    const records = await owner.call('core.logs', { threadId });
    expect(records.map(record => record.event)).toEqual(['turn.finished', 'turn.started', 'turn.queued']);
    expect(records.every(record => record.turnId === turn.id)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('private prompt');
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify({ port: harness.server.port, host: '127.0.0.1', token: harness.token }), { mode: 0o600 });
    for (const json of [false, true]) {
      let output = '', errors = '';
      const code = await runCli(['logs', '--data-dir', harness.dataDir, '--thread', threadId, '--limit', '1', ...(json ? ['--json'] : [])], { env: {}, cwd: harness.dataDir, out: value => { output += value; }, err: value => { errors += value; } });
      expect({ code, errors }).toEqual({ code: 0, errors: '' });
      if (json) expect(JSON.parse(output)[0]).toMatchObject({ event: 'turn.finished', threadId, turnId: turn.id });
      else expect(output).toContain(`INFO turns/turn.finished thread=${threadId} turn=${turn.id} Turn finished: done`);
    }
    let output = '';
    expect(await runCli(['logs', '--data-dir', harness.dataDir, '--json'], { env: {}, cwd: harness.dataDir, out: value => { output += value; }, err: () => undefined })).toBe(0);
    expect(JSON.parse(output)).toBeArray();
  } finally { await harness.stop(); }
});
