import { expect, test } from 'bun:test';
import type { Core } from '../src/core.ts';
import { git } from '../src/git/read.ts';
import { thrown } from './settle.ts';

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
  expect(await thrown(git(failed.core, 'thr_git', process.cwd(), ['status'], 1000))).toThrow('wait failed');
  expect(failed.events).not.toContain('git.timeout');
  const hung = gitCore(new Promise<number>(() => undefined));
  expect(await thrown(git(hung.core, 'thr_git', process.cwd(), ['status'], 20))).toThrow('did not answer within');
  expect(hung.events.filter(event => event === 'git.timeout')).toHaveLength(1);
  // A timeout log that throws still lets the timeout be reported.
  const broken = gitCore(new Promise<number>(() => undefined));
  (broken.core.logs as unknown as { warn: () => never }).warn = () => { throw new Error('log store broken'); };
  (broken.core.logs as unknown as { record: () => never }).record = () => { throw new Error('log store broken'); };
  expect(await thrown(git(broken.core, 'thr_git', process.cwd(), ['status'], 20))).toThrow('did not answer within');
});
