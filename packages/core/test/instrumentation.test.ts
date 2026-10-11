import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CoreLogRecord } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { Core } from '../src/core.ts';
import { forgetStderr, noteStderr, STDERR_TAIL_CHARS, stderrTail } from '../src/drivers/stderr-tail.ts';
import type { SpawnedChild } from '../src/procs.ts';
import { clientField, closeLevel, describeConnection, logHelloRefused, logRpcTiming, slowRpcLevel } from '../src/server/connection-log.ts';
import { errorCodeOf, noteReady } from '../src/drivers/driver-log.ts';
import { isoTime, noteClaudeMessage } from '../src/drivers/claude/diagnostics.ts';
import { detectionLogger } from '../src/providers/install-log.ts';
import { logLoginState } from '../src/account-log.ts';
import type { ProviderSummary } from '@boite/contracts';
import { abnormalExit, programName, watchProviderProcess } from '../src/threads/provider-process-log.ts';
import { gitSubcommand, logGit } from '../src/git/git-log.ts';
import { logUpdate } from '../src/providers/install-log.ts';
import { startTestCore } from './harness.ts';

/** A core whose log store only collects what the code under test records. */
function recordingCore(): { core: Core; records: { level: string; message: string; context: Record<string, unknown> }[] } {
  const records: { level: string; message: string; context: Record<string, unknown> }[] = [];
  const record = (level: string, message: string, context: Record<string, unknown> = {}) => { records.push({ level, message, context }); };
  const logs = { record, info: (m: string, c?: Record<string, unknown>) => record('info', m, c), warn: (m: string, c?: Record<string, unknown>) => record('warn', m, c), debug: (m: string, c?: Record<string, unknown>) => record('debug', m, c), error: (m: string, c?: Record<string, unknown>) => record('error', m, c) };
  return { core: { logs } as unknown as Core, records };
}

test('an agent process that crashes leaves one warning with its exit code and the tail of its stderr in data only', async () => {
  const threadId = 'thr_stderr_tail';
  forgetStderr(threadId);
  for (let index = 0; index < 30; index += 1) noteStderr(threadId, `line ${index} ${'x'.repeat(40)}`);
  noteStderr(threadId, 'fatal: the model refused the session');
  const { core, records } = recordingCore();
  // A stand-in child: on macOS CI a real one sometimes delivered neither `exit` nor `close`
  // within 10 s, and this test is about the record, not the runtime's process events.
  const child = Object.assign(new EventEmitter(), { pid: 4243 }) as unknown as SpawnedChild;
  watchProviderProcess(core, child, '/home/someone/.local/bin/claude', { threadId, turnId: 'trn_1', providerId: 'claude', resume: true });
  child.emit('exit', 3, null);
  child.emit('close', 3, null);
  const crashed = records.find(record => record.context.event === 'driver.process.crashed');
  expect(crashed?.level).toBe('warn');
  const data = crashed?.context.data as Record<string, unknown>;
  expect(data).toMatchObject({ program: 'claude', exitCode: 3, signal: null });
  const tail = String(data.stderrTail);
  // The newest line is kept whole and the total stays within the bound.
  expect(tail.endsWith('fatal: the model refused the session')).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(STDERR_TAIL_CHARS);
  expect(crashed?.message).not.toContain('fatal: the model refused');
  expect(crashed?.message).not.toContain('/home/someone');
  expect(records[0]?.context.event).toBe('driver.process.started');
  forgetStderr(threadId);
});

test('a program that cannot start leaves only its failure, never a start', async () => {
  const { core, records } = recordingCore();
  const child = spawn('/nonexistent/boite-test/claude', [], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedChild;
  watchProviderProcess(core, child, '/nonexistent/boite-test/claude', { threadId: 'thr_missing', providerId: 'claude', resume: false });
  const until = Date.now() + 10_000;
  while (records.length === 0 && Date.now() < until) await Bun.sleep(20);
  await Bun.sleep(50);
  expect(records.map(record => record.context.event)).toEqual(['driver.process.spawn-failed']);
  // The error code, never the spawn message that holds the full path.
  expect(records[0]?.message).toBe('claude for claude could not start (ENOENT)');
});

test('a stop the core asked for is no crash, and old stderr does not describe a new failure', () => {
  expect(abnormalExit(0, null)).toBe(false);
  expect(abnormalExit(null, 'SIGTERM')).toBe(false);
  expect(abnormalExit(null, 'SIGKILL')).toBe(false);
  expect(abnormalExit(null, 'SIGSEGV')).toBe(true);
  expect(abnormalExit(1, null)).toBe(true);
  noteStderr('thr_old', 'from an hour ago', Date.now() - 60 * 60_000);
  expect(stderrTail('thr_old')).toBeNull();
  forgetStderr('thr_old');
  // The thread that keeps printing outlives quieter ones once 256 threads are kept.
  const crowd = Array.from({ length: 255 }, (_, index) => `thr_crowd_${index}`);
  noteStderr('thr_busy', 'first');
  for (const thread of crowd) noteStderr(thread, 'idle');
  noteStderr('thr_busy', 'still printing');
  noteStderr('thr_newcomer', 'new');
  expect(stderrTail('thr_busy')).toBe('first | still printing');
  expect(stderrTail(crowd[0]!)).toBeNull();
  for (const thread of [...crowd, 'thr_busy', 'thr_newcomer']) forgetStderr(thread);
  expect(programName('C:\\Users\\Someone\\AppData\\codex.exe')).toBe('codex');
  // A long line keeps its end, where the cause usually is.
  noteStderr('thr_long', `${'noise '.repeat(200)}fatal: quota exceeded`);
  expect(stderrTail('thr_long')?.endsWith('fatal: quota exceeded')).toBe(true);
  forgetStderr('thr_long');
  // Only a one-key object names its code; `{ code, message }` is no code at all.
  expect(errorCodeOf({ usageLimitExceeded: {} })).toBe('usageLimitExceeded');
  expect(errorCodeOf({ code: 1, message: 'x' })).toBeNull();
  expect(gitSubcommand(['-c', 'core.fsmonitor=', 'worktree', 'add', '-b', 'branch', '/path'])).toBe('worktree add');
  expect(gitSubcommand(['status', '--porcelain=v1'])).toBe('status');
  // A probe that answers no is detail; a content read that fails is a warning.
  const git = recordingCore();
  logGit(git.core, null, ['cat-file', '-e', 'abc'], 1, 3, '');
  logGit(git.core, null, ['cat-file', 'blob', 'abc'], 128, 3, 'fatal: bad object abc');
  logGit(git.core, null, ['diff', '--quiet'], 1, 3, '');
  logGit(git.core, null, ['diff', 'HEAD'], 128, 3, 'fatal: bad revision');
  expect(git.records.map(record => record.level)).toEqual(['debug', 'warn', 'debug', 'warn']);
  logUpdate(git.core, 'codex', 'finished', { state: 'idle', to: '1.2.3' });
  expect(git.records.at(-1)?.message).toBe('Update of codex succeeded, now at 1.2.3');
  logUpdate(git.core, 'codex', 'finished', { state: null, to: null });
  expect(git.records.at(-1)?.message).toBe('Update of codex ended with state unknown, now at unknown');
});

test('slow RPC thresholds: debug from 1 s, warn from 10 s except for methods that hold their answer on purpose', () => {
  expect(slowRpcLevel('threads.list', 999)).toBeNull();
  expect(slowRpcLevel('threads.list', 1000)).toBe('debug');
  expect(slowRpcLevel('threads.list', 10_000)).toBe('warn');
  expect(slowRpcLevel('delegation.wait', 600_000)).toBe('debug');
  expect(slowRpcLevel('questions.ask', 60_000)).toBe('debug');
  expect(slowRpcLevel('browser.command', 30_000)).toBe('debug');
  expect(closeLevel(1006, '', true, 'owner')).toBe('warn');
  expect(closeLevel(1000, '', true, 'owner')).toBe('info');
  expect(closeLevel(1000, '', true, 'agent')).toBe('debug');
  expect(closeLevel(4001, 'hello timed out', false, 'unauthenticated')).toBe('warn');
});

test('a connection logs who it was, how long it lived and who closed it; a refused hello says why', async () => {
  const harness = await startTestCore();
  const find = async (event: string): Promise<CoreLogRecord | undefined> => (await harness.core.logs.select(record => record.event === event, 10))[0];
  try {
    const client = await connect(harness.url, harness.token);
    await client.call('threads.list', {});
    client.close();
    let closed: CoreLogRecord | undefined;
    for (let tries = 0; tries < 50 && closed === undefined; tries += 1) {
      closed = await find('connection.closed');
      if (closed === undefined) await Bun.sleep(20);
    }
    expect(closed).toMatchObject({ source: 'connections', data: { principal: 'owner', closedBy: 'client', remote: false } });
    expect(typeof closed?.durationMs).toBe('number');
    expect((await find('connection.hello'))?.data?.principal).toBe('owner');

    await expect(connect(harness.url, 'not-the-token')).rejects.toThrow('the token is wrong');
    const refused = await find('connection.hello-refused');
    expect(refused?.level).toBe('warn');
    expect(refused?.message).toContain('bad token');
    expect(JSON.stringify(refused)).not.toContain('not-the-token');
  } finally { await harness.stop(); }
});

test('a session open that throws before its first await is logged as a failure, and the clock covers synchronous setup', async () => {
  const notes: { level: string; message: string; event: string; durationMs?: number }[] = [];
  const ctx = { sessionId: null, diagnostic: (level: string, message: string, context: { event: string; durationMs?: number }) => { notes.push({ level, message, ...context }); } };
  await expect(noteReady(ctx, 'pi', () => { throw new Error('no pi executable on this machine'); })).rejects.toThrow('no pi executable');
  expect(notes).toMatchObject([{ level: 'warn', event: 'driver.session.open-failed' }]);
  notes.length = 0;
  // A stop that a driver can only report by throwing is an abandoned open, not a failure.
  await expect(noteReady(ctx, 'acp', () => Promise.reject(Object.assign(new Error('closed before it started'), { abandoned: true })))).rejects.toThrow('closed before');
  expect(notes).toMatchObject([{ level: 'debug', event: 'driver.session.open-abandoned' }]);
  notes.length = 0;
  // Codex and Muse close the process to stop an open in flight: the plain rejection that follows is routine too.
  await expect(noteReady(ctx, 'Codex app-server', () => Promise.reject(new Error('the codex startup was stopped')), undefined, () => true)).rejects.toThrow('startup was stopped');
  expect(notes).toMatchObject([{ level: 'debug', event: 'driver.session.open-abandoned' }]);
  notes.length = 0;
  await expect(noteReady(ctx, 'Codex app-server', () => Promise.reject(new Error('spawn codex ENOENT')), undefined, () => false)).rejects.toThrow('ENOENT');
  expect(notes).toMatchObject([{ level: 'warn', event: 'driver.session.open-failed' }]);
  notes.length = 0;
  await noteReady(ctx, 'pi', () => { const until = Date.now() + 30; while (Date.now() < until) { /* synchronous setup */ } return Promise.resolve(); }, () => ({ text: ', on gpt', data: { model: 'gpt' } }));
  expect(notes[0]).toMatchObject({ level: 'info', event: 'driver.session.ready' });
  expect(notes[0]!.durationMs).toBeGreaterThanOrEqual(25);
  expect(notes[0]!.message).toContain(', on gpt');
  // A resume asked for that came back new says both.
  notes.length = 0;
  await noteReady({ ...ctx, sessionId: 'ses_old' }, 'pi', () => Promise.resolve(), () => ({ resumed: false }));
  expect(notes[0]).toMatchObject({ event: 'driver.session.ready', data: { resume: true, resumed: false } });
});

test('log fields from an unauthenticated hello cannot forge a line, and a reset time a Date cannot hold is dropped', () => {
  expect(clientField('shell\n2026-10-10 ERROR core forged')).toBe('shell2026-10-10 ERROR core forged'.slice(0, 40));
  expect(clientField('\u0000\u2028')).toBe('unknown');
  expect(clientField(42)).toBe('unknown');
  expect(isoTime(1_760_000_000)).toBe(new Date(1_760_000_000_000).toISOString());
  expect(isoTime(1e300)).toBeNull();
  expect(isoTime(Number.NaN)).toBeNull();
});

test('provider detection warns once when the rejected descriptor count changes, not on every other change', () => {
  const { core, records } = recordingCore();
  const log = detectionLogger(core);
  const provider = (available: boolean) => ({ id: 'codex', executable: null, available, enabled: true }) as unknown as ProviderSummary;
  log([provider(true)], 0);
  log([provider(true)], 1);
  log([provider(false)], 1);
  log([provider(true)], 1);
  const rejected = records.filter(record => record.context.event === 'provider.rejected');
  expect(rejected).toHaveLength(1);
  // The warning belongs to the call where the count moved, before the two availability changes.
  expect(records.findIndex(record => record.context.event === 'provider.rejected')).toBe(1);
  expect(records.filter(record => record.context.event === 'provider.detected')).toHaveLength(3);
  // A program name may hold any character the file system allows, `|` included.
  log([provider(true), { id: 'pipe', executable: '/opt/odd|name', available: true, enabled: true } as unknown as ProviderSummary], 1);
  expect(records.at(-1)?.context.data).toMatchObject({ providerId: 'pipe', state: 'available', program: 'odd|name', version: null });
});


test('a failed Claude result without an error list is logged, not thrown into the receive loop', () => {
  const notes: { level: string; event: string; data?: Record<string, unknown> }[] = [];
  const ctx = { diagnostic: (level: string, _message: string, context: { event: string; data?: Record<string, unknown> }) => { notes.push({ level, ...context }); } };
  noteClaudeMessage(ctx, { type: 'result', subtype: 'error_from_a_newer_cli', is_error: true, num_turns: 2, duration_ms: 10, duration_api_ms: 5 } as never, null);
  expect(notes).toMatchObject([{ level: 'warn', event: 'driver.result.error', data: { errors: 0 } }]);
  // A rate-limit event without its info is skipped too.
  noteClaudeMessage(ctx, { type: 'rate_limit_event' } as never, null);
  expect(notes).toHaveLength(1);
});

test('two cores in one process time their own logins, even for the same account id', () => {
  const first = recordingCore();
  const second = recordingCore();
  const account = { id: 'acc_same', providerId: 'claude' } as never;
  logLoginState(first.core, account, 'running', '', null);
  logLoginState(second.core, account, 'running', '', null);
  expect(second.records.map(record => record.context.event)).toEqual(['account.login.started']);
  logLoginState(first.core, account, 'done', '', 0);
  logLoginState(second.core, account, 'done', '', 0);
  for (const { records } of [first, second]) expect(typeof records.find(record => record.context.event === 'account.login.succeeded')?.context.durationMs).toBe('number');
  // A failed login keeps the sign-in site and drops the link's device or OAuth parameters.
  logLoginState(first.core, account, 'failed', 'Open https://claude.ai/oauth/device/ABCD-1234?code=secret-code to sign in', 1);
  const failed = first.records.find(record => record.context.event === 'account.login.failed');
  expect(failed?.message).toContain('Open https://claude.ai/<redacted> to sign in');
  expect(JSON.stringify(failed)).not.toContain('ABCD-1234');
  // A sign-in the user cancelled is lifecycle, not a failure.
  logLoginState(second.core, account, 'failed', 'Sign-in cancelled', 1);
  expect(second.records.at(-1)).toMatchObject({ level: 'info', context: { event: 'account.login.cancelled' } });
});

test('a method name the client chose cannot forge a line in a refused or slow RPC record', () => {
  const { core, records } = recordingCore();
  const connection = { identity: { principal: 'owner', threadId: null } } as never;
  logRpcTiming(core, connection, 'nope\n2026-10-10 ERROR core forged', 'r1', 3, { code: -32601, message: 'unknown method' } as never);
  logRpcTiming(core, connection, 'slow\u2028forged', 'r2', 12_000, null);
  // A refusal echoing the client's value, and the client's own name at hello.
  logRpcTiming(core, connection, 'push.subscribe', 'r3', 3, { code: -32602, message: 'home.name: bad\n2026-10-10 ERROR core forged' } as never);
  logHelloRefused(core, { id: 'c1', remote: false } as never, 'bad ticket: x\n2026-10-10 ERROR core forged', 'app\n2026-10-10 ERROR core forged');
  expect(describeConnection({ authenticated: false, remote: false, clientName: 'app\u2028forged' } as never).client).toBe('appforged');
  for (const record of records) expect(`${record.message}${JSON.stringify(record.context.data)}`).not.toMatch(/[\n\u2028]/);
  expect(records.map(record => record.context.event)).toEqual(['rpc.refused', 'rpc.slow', 'rpc.refused', 'connection.hello-refused']);
});

test('a process that reports its exit but never closes is still logged, with its exit time', async () => {
  const { core, records } = recordingCore();
  const child = Object.assign(new EventEmitter(), { pid: 4242 }) as unknown as SpawnedChild;
  watchProviderProcess(core, child, 'codex', { threadId: 'thr_no_close', providerId: 'codex', resume: false });
  child.emit('exit', 1, null);
  const until = Date.now() + 5_000;
  while (!records.some(record => record.context.event === 'driver.process.crashed') && Date.now() < until) await Bun.sleep(50);
  const crashed = records.find(record => record.context.event === 'driver.process.crashed');
  expect(crashed?.context.data).toMatchObject({ exitCode: 1, pid: 4242 });
  // The lifetime ends at the exit, not after the wait for `close`.
  expect(Number(crashed?.context.durationMs)).toBeLessThan(1_000);
  // A late `close` writes no second record.
  child.emit('close', 1, null);
  expect(records.filter(record => record.context.event === 'driver.process.crashed')).toHaveLength(1);
});
