import { expect, test } from 'bun:test';
import type { Core } from '../src/core.ts';
import { git } from '../src/git/read.ts';

/** A core with a fake launcher and a log store that only collects event names. */
function gitCore(exited: Promise<number>): { core: Core; events: string[] } {
  const events: string[] = [];
  const record = (_level: string, _message: string, context: { event?: string } = {}) => { if (context.event) events.push(context.event); };
  const logs = { record, info: (m: string, c?: { event?: string }) => record('info', m, c), warn: (m: string, c?: { event?: string }) => record('warn', m, c), debug: (m: string, c?: { event?: string }) => record('debug', m, c), error: (m: string, c?: { event?: string }) => record('error', m, c) };
  const empty = () => new ReadableStream({ start: controller => controller.close() });
  const procs = { spawn: () => ({ proc: { stdout: empty(), stderr: empty(), kill: () => undefined }, exited }) };
  return { core: { logs, procs } as unknown as Core, events };
}

test('a git read is logged as a timeout only when its deadline fired', async () => {
  const failed = gitCore(Promise.reject(new Error('wait failed')));
  await expect(git(failed.core, 'thr_git', process.cwd(), ['status'], 1000)).rejects.toThrow('wait failed');
  expect(failed.events).not.toContain('git.timeout');
  const hung = gitCore(new Promise<number>(() => undefined));
  await expect(git(hung.core, 'thr_git', process.cwd(), ['status'], 20)).rejects.toThrow('did not answer within');
  expect(hung.events.filter(event => event === 'git.timeout')).toHaveLength(1);
});
