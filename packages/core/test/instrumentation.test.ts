import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import type { CoreLogRecord } from '@boite/contracts';
import { connect } from '../src/client.ts';
import type { Core } from '../src/core.ts';
import { forgetStderr, noteStderr, STDERR_TAIL_CHARS, stderrTail } from '../src/drivers/stderr-tail.ts';
import type { SpawnedChild } from '../src/procs.ts';
import { closeLevel, slowRpcLevel } from '../src/server/connection-log.ts';
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
