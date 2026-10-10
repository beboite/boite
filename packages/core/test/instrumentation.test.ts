import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import type { CoreLogRecord } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { Core } from '../src/core.ts';
import { forgetStderr, noteStderr, STDERR_TAIL_CHARS, stderrTail } from '../src/drivers/stderr-tail.ts';
import type { SpawnedChild } from '../src/procs.ts';
import { clientField, closeLevel, slowRpcLevel } from '../src/server/connection-log.ts';
import { noteReady } from '../src/drivers/driver-log.ts';
import { isoTime, noteClaudeMessage } from '../src/drivers/claude/diagnostics.ts';
import { git } from '../src/git/read.ts';
import { detectionLogger } from '../src/providers/install-log.ts';
import type { ProviderSummary } from '@boite/contracts';
import { abnormalExit, programName, watchProviderProcess } from '../src/threads/provider-process-log.ts';
import { gitSubcommand } from '../src/git/git-log.ts';
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
  const child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as SpawnedChild;
  watchProviderProcess(core, child, '/home/someone/.local/bin/claude', { threadId, turnId: 'trn_1', providerId: 'claude', resume: true });
  await new Promise<void>(resolve => child.once('close', () => resolve()));
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
  expect(gitSubcommand(['-c', 'core.fsmonitor=', 'worktree', 'add', '-b', 'branch', '/path'])).toBe('worktree add');
  expect(gitSubcommand(['status', '--porcelain=v1'])).toBe('status');
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
});


test('a failed Claude result without an error list is logged, not thrown into the receive loop', () => {
  const notes: { level: string; event: string; data?: Record<string, unknown> }[] = [];
  const ctx = { diagnostic: (level: string, _message: string, context: { event: string; data?: Record<string, unknown> }) => { notes.push({ level, ...context }); } };
  noteClaudeMessage(ctx, { type: 'result', subtype: 'error_from_a_newer_cli', is_error: true, num_turns: 2, duration_ms: 10, duration_api_ms: 5 } as never, null);
  expect(notes).toMatchObject([{ level: 'warn', event: 'driver.result.error', data: { errors: 0 } }]);
});

test('a git read is logged as a timeout only when its deadline fired', async () => {
  const { core, records } = recordingCore();
  const spawnWith = (exited: Promise<number>) => ({ spawn: () => ({ proc: { stdout: new ReadableStream({ start: c => c.close() }), stderr: new ReadableStream({ start: c => c.close() }), kill: () => undefined }, exited }) });
  (core as unknown as { procs: unknown }).procs = spawnWith(Promise.reject(new Error('wait failed')));
  await expect(git(core, 'thr_git', process.cwd(), ['status'], 1000)).rejects.toThrow('wait failed');
  expect(records.filter(record => record.context.event === 'git.timeout')).toHaveLength(0);
  (core as unknown as { procs: unknown }).procs = spawnWith(new Promise<number>(() => undefined));
  await expect(git(core, 'thr_git', process.cwd(), ['status'], 20)).rejects.toThrow('did not answer within');
  expect(records.filter(record => record.context.event === 'git.timeout')).toHaveLength(1);
});
