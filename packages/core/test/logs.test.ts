import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCoreLogText, RpcErrorCode, type ProcessRecord, type RpcEvents, type Turn } from '@boite/contracts';
import { Bus } from '../src/bus.ts';
import { DiagnosticLogs, LOG_FILE_COUNT, LOG_MESSAGE_CHARS, redactLogText, SHORT_PROCESS_MS } from '../src/logs.ts';
import { runCli } from '../src/cli.ts';
import { connect } from '../src/client.ts';
import { setDriver } from '../src/drivers/index.ts';
import { withLogDiagnostic } from '../src/log-errors.ts';
import { echoThread, startTestCore, waitFor } from './harness.ts';
import { rejection, thrown } from './settle.ts';

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
    for (const input of ['service-api-key=synthetic-private-value', 'user_api_key={"value":"synthetic-private-value"}', 'payload_content="synthetic-private-value"', 'prompts: "synthetic-private-value"']) {
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
        bus.emit('process.exited', { ...proc, exitedAt: proc.startedAt + SHORT_PROCESS_MS, exitCode: 0 });
      });
      const records = await logs.query({ threadId: turn.threadId });
      expect(records.map(record => record.event)).toEqual(['process.exited', 'turn.finished', 'process.started', 'turn.started', 'turn.queued']);
      expect(records.every(record => record.turnId === turn.id)).toBe(true);
      expect(records[1]?.level).toBe('error');
      // The program's file name says which tool exited; its folder and arguments stay in the trace view.
      expect(JSON.stringify(records)).not.toMatch(/private|rolled-back|--prompt|secret/);
      expect(records[0]?.data).toMatchObject({ pid: 123, exe: 'provider', exitCode: 0 });
      expect(records[1]?.durationMs).toBe(2);
    } finally { bus.dispose(); await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('short clean processes count in one batch per turn; crashed, unknown and running ones keep their own records', async () => {
    const directory = temporary();
    const logs = new DiagnosticLogs(directory);
    const bus = new Bus(); logs.attach(bus);
    try {
      bus.afterCommit(() => bus.emit('turn.started', turn));
      const quick = (pid: number, exe: string, exitCode: number | null = 0) => {
        const started = { ...proc, pid, exe, startedAt: 10_000 + pid };
        bus.afterCommit(() => { bus.emit('process.started', started); bus.emit('process.exited', { ...started, exitedAt: started.startedAt + 30, exitCode, cpuMs: 5 }); });
      };
      quick(1, '/usr/bin/bash.exe');
      quick(2, '/usr/bin/bash.exe');
      quick(3, 'C:\\Git\\usr\\bin\\sed.exe');
      quick(4, '/usr/bin/bash.exe', 0xC0000005);
      // An exit whose status the OS did not give: the batch could not say how it ended.
      quick(6, '/usr/bin/git.exe', null);
      bus.afterCommit(() => bus.emit('process.started', { ...proc, pid: 5, exe: '/bin/cargo', startedAt: 10_005 }));
    } finally { bus.dispose(); await logs.close(); }
    // Closing writes what was still gathering.
    const reader = new DiagnosticLogs(directory);
    try {
      const records = (await reader.query({ threadId: turn.threadId })).filter(record => record.source === 'processes');
      expect(records.map(record => `${record.event} ${record.data?.pid ?? ''}`).sort()).toEqual(['process.batch ', 'process.exited 4', 'process.exited 6', 'process.started 4', 'process.started 5', 'process.started 6']);
      const batch = records.find(record => record.event === 'process.batch')!;
      expect(batch).toMatchObject({ level: 'debug', turnId: turn.id, at: 10_001, durationMs: 32, message: '3 short processes ran: bash.exe 2, sed.exe 1', data: { count: 3, cpuMs: 15, exes: 'bash.exe 2, sed.exe 1' } });
      expect(records.find(record => record.event === 'process.exited' && record.data?.pid === 4)?.level).toBe('warn');
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
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

  test('a log folder blocked at startup is written once it is free, with no flush asked', async () => {
    const directory = temporary();
    writeFileSync(join(directory, 'logs'), 'a file blocks the directory');
    const logs = new DiagnosticLogs(directory, [], () => undefined);
    try {
      await logs.query({});
      rmSync(join(directory, 'logs'));
      logs.record('info', 'after the folder came back');
      await waitFor(() => existsSync(join(directory, 'logs', 'core.0.ndjson')));
    } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('persistence resumes once the obstruction is gone, with every record written once and the outage logged', async () => {
    const directory = temporary();
    const reports: string[] = [];
    const file = join(directory, 'logs', 'core.0.ndjson');
    const logs = new DiagnosticLogs(directory, [], message => reports.push(message));
    try {
      logs.record('info', 'before');
      await logs.flush();
      // Something takes the newest file's place for a while: a folder, as a full disk or a lock would.
      rmSync(file);
      mkdirSync(file);
      logs.record('info', 'during');
      await logs.flush();
      logs.record('info', 'still during');
      await logs.flush();
      expect(reports).toHaveLength(1);
      rmSync(file, { recursive: true });
      logs.record('info', 'after');
      // No flush asked: the retry the last failure scheduled writes the queue by itself.
      await waitFor(() => existsSync(file) && statSync(file).isFile() && readFileSync(file, 'utf8').includes('written again'));
    } finally { await logs.close(); }
    const reader = new DiagnosticLogs(directory);
    try {
      const messages = (await reader.query({})).map(record => record.message).reverse();
      expect(messages.filter(message => message !== 'before')).toEqual(['during', 'still during', 'after', 'diagnostic logs are written again after 2 failed attempts']);
      expect(reports).toHaveLength(1);
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
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

  test('after a restart, a backdated record in the newest file does not hide newer records in older files, and data is redacted with current secrets', async () => {
    const directory = temporary();
    const now = Date.now();
    const writer = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      for (let index = 0; index < 20; index += 1) writer.record('info', `recent ${index} ${'x'.repeat(150)}`, { source: 'test', event: 'recent', data: { where: 'later-secret here' } }, now - 20_000 + index * 1000);
      await writer.flush();
      // Written last, dated first: a turn logged with the time it was queued.
      writer.record('info', 'queued long ago', { source: 'test', event: 'backdated' }, now - 3_600_000);
    } finally { await writer.close(); }
    const reader = new DiagnosticLogs(directory, ['later-secret'], undefined, 1024);
    try {
      const newest = await reader.query({ limit: 3 });
      expect(newest.map(record => record.message.split(' ').slice(0, 2).join(' '))).toEqual(['recent 19', 'recent 18', 'recent 17']);
      expect(newest[0]?.data?.where).toBe('[redacted] here');
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a file past the read cap answers with its newest records, the ones at its end', async () => {
    const directory = temporary();
    mkdirSync(join(directory, 'logs'), { recursive: true });
    const now = Date.now();
    // About 2.5 MiB, past the 2 MiB a read takes: a file written under a larger limit.
    const lines = Array.from({ length: 10_000 }, (_, index) => JSON.stringify({ id: `old:${index}`, runId: 'old', at: now - 10_000_000 + index * 1000, level: 'info', source: 'test', event: 'big', message: `line ${index} ${'x'.repeat(200)}` }));
    writeFileSync(join(directory, 'logs', 'core.0.ndjson'), `${lines.join('\n')}\n`, { mode: 0o600 });
    const reader = new DiagnosticLogs(directory);
    try {
      expect((await reader.query({ limit: 1 }))[0]?.id).toBe('old:9999');
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('records of the same millisecond across files come newest first', async () => {
    const directory = temporary();
    const at = Date.now();
    const writer = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      for (let index = 0; index < 20; index += 1) writer.record('info', `same ${index} ${'x'.repeat(150)}`, { source: 'test', event: 'same' }, at);
    } finally { await writer.close(); }
    const reader = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      const newest = await reader.query({ limit: 8 });
      expect(newest.map(record => record.message.split(' ').slice(0, 2).join(' '))).toEqual(['same 19', 'same 18', 'same 17', 'same 16', 'same 15', 'same 14', 'same 13', 'same 12']);
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a missing file between rotated ones does not hide the older files behind it', async () => {
    const directory = temporary();
    const now = Date.now();
    const writer = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      for (let index = 0; index < 20; index += 1) writer.record('info', `recent ${index} ${'x'.repeat(150)}`, { source: 'test', event: 'recent' }, now - 20_000 + index * 1000);
      await writer.flush();
      // Enough to rotate: the newest file then holds only records dated long ago.
      for (let index = 0; index < 7; index += 1) writer.record('info', `queued long ago ${index} ${'x'.repeat(200)}`, { source: 'test', event: 'backdated' }, now - 3_600_000);
    } finally { await writer.close(); }
    rmSync(join(directory, 'logs', 'core.1.ndjson'));
    expect(existsSync(join(directory, 'logs', 'core.2.ndjson'))).toBe(true);
    const reader = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      const newest = await reader.query({ limit: 1 });
      expect(newest.map(record => record.event)).toEqual(['recent']);
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a query with `since` skips the files last written before it, a client clock skew allowed', async () => {
    const directory = temporary();
    mkdirSync(join(directory, 'logs'), { recursive: true });
    const now = Date.now();
    // Each file holds a record dated now, which only a file still being written can hold:
    // finding it in a file written long before `since` means the file was read.
    const file = (name: string, modifiedAgoMs: number): void => {
      const path = join(directory, 'logs', name);
      writeFileSync(path, `${JSON.stringify({ id: `${name}:1`, runId: 'old', at: now, level: 'info', source: 'test', event: 'file', message: name })}\n`, { mode: 0o600 });
      utimesSync(path, (now - modifiedAgoMs) / 1000, (now - modifiedAgoMs) / 1000);
    };
    file('core.0.ndjson', 0);
    file('core.1.ndjson', 5 * 60_000);
    file('core.2.ndjson', 60 * 60_000);
    file('core.3.ndjson', 0);
    file('shell.0.ndjson', 2 * 60 * 60_000);
    file('shell.1.ndjson', 0);
    const reader = new DiagnosticLogs(directory);
    try {
      const names = async (since?: number): Promise<string[]> => (await reader.query({ since, limit: 100 })).map(record => record.message).sort();
      expect(await names()).toEqual(['core.0.ndjson', 'core.1.ndjson', 'core.2.ndjson', 'core.3.ndjson', 'shell.0.ndjson', 'shell.1.ndjson']);
      // core.1 is within the skew of `since`; core.2 is older, so it and every older rotation stay closed.
      expect(await names(now - 1000)).toEqual(['core.0.ndjson', 'core.1.ndjson', 'shell.1.ndjson']);
    } finally { await reader.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('memory keeps only what the files do not hold: a written record is answered from its file', async () => {
    const directory = temporary();
    const logs = new DiagnosticLogs(directory, [], undefined, 1024);
    try {
      logs.record('info', 'written');
      // Longer than a whole file: never written, so memory still answers for it.
      logs.record('info', `too large ${'x'.repeat(2000)}`);
      expect((await logs.query({})).map(record => record.message.slice(0, 9))).toEqual(['too large', 'written']);
      rmSync(join(directory, 'logs', 'core.0.ndjson'));
      expect((await logs.query({})).map(record => record.message.slice(0, 9))).toEqual(['too large']);
    } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  test('a burst cannot grow the pending queue and persists an explicit loss count', async () => {
    const directory = temporary();
    const reports: string[] = [];
    const logs = new DiagnosticLogs(directory, [], message => reports.push(message));
    try {
      for (let index = 0; index < 1100; index += 1) logs.record('info', `burst ${index}`, {}, 1000 + index);
      const records = await logs.query({ limit: 2 });
      expect(records[0]).toMatchObject({ event: 'logs.dropped', level: 'warn', message: '76 diagnostics were not persisted because the pending buffer was full', data: { count: 76 } });
      expect(records[1]?.message).toBe('burst 1099');
      expect(reports).toHaveLength(1);
      await logs.close();
      const restarted = new DiagnosticLogs(directory);
      try {
        const retained = await restarted.query({ limit: 2 });
        expect(retained[0]?.event).toBe('logs.dropped');
        expect(retained[1]?.message).toBe('burst 1023');
      } finally { await restarted.close(); }
    } finally { await logs.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});

const invalidQueries: unknown[] = [null, [], 'all', { limit: 0 }, { limit: 1001 }, { limit: 1.5 }, { limit: null }, { limit: '10' }, { threadId: '' }, { threadId: 'x'.repeat(201) }, { threadId: 'bad\nthread' }, { level: 'trace' }, { level: {} }, { minLevel: 'verbose' }, { origin: 'kernel' }, { since: -1 }, { anonymize: 'yes' }, { before: 1 }];

test('real logs queries enforce strict validation, newest-first filters and owner-only access', async () => {
  const harness = await startTestCore();
  try {
    const owner = await harness.connect();
    const { threadId } = await echoThread(harness, owner);
    // Newest first is by time: a record dated in the past sorts below newer ones.
    harness.core.bus.emit('core.log', { at: Date.now() + 1000, level: 'info', message: 'first diagnostic' });
    harness.core.bus.emit('core.log', { at: Date.now() + 2000, level: 'warn', message: 'second diagnostic' });
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
      harness.core.bus.emit('core.log', { level: 'warn', at: Date.now() + 3000, message, source: 'acp', event: 'provider.output', kind: 'provider-output', threadId });
      const [retained] = await owner.call('core.logs', { limit: 1 });
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ kind: 'provider-output', source: 'acp', threadId, message: `Open the following link: ${oauth}\ncore handle [redacted]` });
      expect(live[0]?.message).not.toContain(harness.token);
      expect(retained).toMatchObject({ message: '[provider output omitted]', threadId, source: 'acp', event: 'provider.output' });
      const persisted = readFileSync(join(harness.dataDir, 'logs', 'core.0.ndjson'), 'utf8');
      expect(persisted).not.toContain(oauth);
      expect(persisted).not.toContain('synthetic-state');
      for (const client of [agent, phone]) for (const id of [threadId, 'another-thread']) expect((await rejection(client.call('core.logs', { threadId: id }))).reason).toMatchObject({ rpc: { code: RpcErrorCode.Refused } });
      expect(agentLogs).toEqual([]);
      expect(phoneLogs).toEqual([]);
      // Even a long output stays usable and bounded for its owner, while retention stays fixed.
      const known = harness.token;
      // Newer than the record above, and about no thread, so `limit: 1` reads this one.
      harness.core.bus.emit('core.log', { level: 'warn', at: Date.now() + 4000, message: 'x'.repeat(4090) + known + 'y'.repeat(8000), kind: 'provider-output' });
      const [long] = await owner.call('core.logs', { limit: 1 });
      expect(long).toMatchObject({ message: '[provider output omitted]' });
      expect(long?.threadId).toBeUndefined();
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
    expect((await rejection(owner.call('projects.list', {}))).reason).toMatchObject({ rpc: { code: RpcErrorCode.Internal, message: 'Something went wrong. Try again.' } });
    const [record] = await owner.call('core.logs', { level: 'error' });
    expect(record).toMatchObject({ source: 'rpc', event: 'rpc.failed' });
    expect(record?.requestId).toBeString();
    expect(record?.message).toContain('SQLite failed');
    expect(record?.message).toContain('caused by: disk full');
    expect(record?.message).not.toContain(harness.token);
    expect(logEvents).toEqual([]);
  } finally { await harness.stop(); }
});

test('known stderr remains in the turn error, reaches the owner log only as data.stderrTail and never an agent view or export', async () => {
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
    // The agent's stderr is the cause a developer needs: kept for the owner in one field, never in a message.
    const tail = records.find(record => record.event === 'turn.failed.stderr');
    expect(tail).toMatchObject({ level: 'warn', threadId, turnId: turn.id, data: { stderrTail: 'private prompt echoed to stderr' } });
    expect(records.map(record => record.message).join('\n')).not.toContain('private prompt');
    expect(JSON.stringify(records.filter(record => record !== tail))).not.toContain('private prompt');
    expect(JSON.stringify(await owner.call('diagnostics.logs', { threadId, scope: 'thread' }))).not.toContain('private prompt');
    expect((await owner.call('diagnostics.export', { focusThreadId: threadId })).text).not.toContain('private prompt');
    expect(records.find(record => record.event === 'turn.failed')).toMatchObject({ source: 'echo', threadId, turnId: turn.id, message: `turn ${turn.id} failed: ${diagnostic}` });
    expect(records.find(record => record.event === 'provider.output')?.message).toBe('[provider output omitted]');
    const error = withLogDiagnostic(new Error(raw), diagnostic);
    expect(error.message).toBe(raw);
    harness.core.router.register('projects.list', () => { throw error; });
    expect(await thrown(owner.call('projects.list', {}))).toThrow('Something went wrong. Try again.');
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
    expect(records.map(record => record.event)).toEqual(['turn.finished', 'turn.attempt.finished', 'turn.attempt.started', 'turn.started', 'turn.queued']);
    expect(records.every(record => record.turnId === turn.id)).toBe(true);
    expect(JSON.stringify(records)).not.toContain('private prompt');
    writeFileSync(join(harness.dataDir, 'core.json'), JSON.stringify({ port: harness.server.port, host: '127.0.0.1', token: harness.token }), { mode: 0o600 });
    for (const json of [false, true]) {
      let output = '', errors = '';
      const code = await runCli(['logs', '--data-dir', harness.dataDir, '--thread', threadId, '--limit', '1', ...(json ? ['--json'] : [])], { env: {}, cwd: harness.dataDir, out: value => { output += value; }, err: value => { errors += value; } });
      expect({ code, errors }).toEqual({ code: 0, errors: '' });
      if (json) expect(JSON.parse(output)[0]).toMatchObject({ event: 'turn.finished', threadId, turnId: turn.id });
      else expect(output).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z INFO  core  turns/turn\\.finished \\[${threadId} echo/echo turn=${turn.id}\\] \\(\\d+ ms\\) Turn finished: done \\{status=done`));
    }
    let output = '';
    expect(await runCli(['logs', '--data-dir', harness.dataDir, '--json'], { env: {}, cwd: harness.dataDir, out: value => { output += value; }, err: () => undefined })).toBe(0);
    expect(JSON.parse(output)).toBeArray();
  } finally { await harness.stop(); }
});
