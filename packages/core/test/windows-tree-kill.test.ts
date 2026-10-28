import { expect, test } from 'bun:test';
import { treeKill } from '../src/platform/windows/tree-kill.ts';

test('the tree kill holds the root from the call until taskkill ended, while the root exits meanwhile', async () => {
  const steps: string[] = [];
  let finish!: () => void;
  const ran = treeKill(41, pid => {
    steps.push(`hold ${pid}`);
    return () => steps.push('release');
  }, pid => {
    steps.push(`taskkill ${pid}`);
    return new Promise<void>(resolve => { finish = resolve; });
  });
  // Held before the call returns: the caller's liveness check and the hold share one tick.
  expect(steps).toEqual(['hold 41', 'taskkill 41']);
  // The root exits and its spawner closes its own handle while taskkill has not opened the pid yet.
  await Bun.sleep(0);
  expect(steps).toEqual(['hold 41', 'taskkill 41']);
  finish();
  await ran;
  expect(steps).toEqual(['hold 41', 'taskkill 41', 'release']);
});

test('a root the hold cannot open gets no taskkill, and a taskkill that fails still releases', async () => {
  const runs: number[] = [];
  expect(treeKill(42, () => null, pid => { runs.push(pid); return Promise.resolve(); })).toBeUndefined();
  expect(runs).toEqual([]);

  let released = 0;
  expect(treeKill(43, () => () => released++, () => { throw new Error('no taskkill'); })).toBeUndefined();
  expect(released).toBe(1);
  await treeKill(44, () => () => released++, () => Promise.reject(new Error('taskkill crashed')));
  expect(released).toBe(2);
});
