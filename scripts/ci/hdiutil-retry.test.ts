import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { attachedUnder, BUSY, withRetry } from './hdiutil-retry.ts';

// The line that failed the Apple Silicon DMG of nightly run 37213994348.
const busy = 'hdiutil: create failed - Resource busy\nfailed to bundle project: error running bundle_dmg.sh';

function attempts(...results: [number, string][]) {
  const calls: number[] = [];
  const retries: number[] = [];
  let index = 0;
  const attempt = async () => {
    calls.push(index);
    const [code, output] = results[Math.min(index++, results.length - 1)]!;
    return { code, output };
  };
  return { calls, retries, attempt, beforeRetry: async (next: number) => { retries.push(next); } };
}

test('a busy disk image is bundled again until it succeeds', async () => {
  const run = attempts([1, busy], [0, 'Finished 2 bundles']);
  expect(await withRetry(run.attempt, run.beforeRetry)).toBe(0);
  expect(run.calls).toHaveLength(2);
  expect(run.retries).toEqual([2]);
});

test('any other failure ends at once with its own exit code', async () => {
  const run = attempts([101, 'error[E0425]: cannot find value `window` in this scope']);
  expect(await withRetry(run.attempt, run.beforeRetry)).toBe(101);
  expect(run.calls).toHaveLength(1);
  expect(run.retries).toEqual([]);
});

test('a runner that stays busy fails after the last attempt', async () => {
  const run = attempts([1, busy]);
  expect(await withRetry(run.attempt, run.beforeRetry)).toBe(1);
  expect(run.calls).toHaveLength(3);
  expect(run.retries).toEqual([2, 3]);
});

test('every hdiutil step that can be busy is recognized, and nothing else', () => {
  for (const verb of ['create', 'attach', 'detach', 'convert']) expect(BUSY.test(`hdiutil: ${verb} failed - Resource busy`)).toBe(true);
  expect(BUSY.test('hdiutil: create failed - No space left on device')).toBe(false);
  expect(BUSY.test('rm: Boite.app: Resource busy')).toBe(false);
});

test('only images attached from under the bundle directory are detached, by their whole disk', () => {
  const bundle = join('/tmp', 'target', 'release', 'bundle');
  const info = {
    images: [
      { 'image-path': join(bundle, 'dmg', 'rw.4242.Boite_2.0.0_aarch64.dmg'), 'system-entities': [
        { 'dev-entry': '/dev/disk4' }, { 'dev-entry': '/dev/disk4s1', 'mount-point': '/Volumes/Boite' },
      ] },
      { 'image-path': '/Applications/Xcode.dmg', 'system-entities': [{ 'dev-entry': '/dev/disk5' }] },
      { 'image-path': join('/tmp', 'target', 'release', 'bundle-other', 'x.dmg'), 'system-entities': [{ 'dev-entry': '/dev/disk6' }] },
    ],
  };
  expect(attachedUnder(info, bundle)).toEqual(['/dev/disk4']);
  expect(attachedUnder({}, bundle)).toEqual([]);
});

test('the command streams its output and keeps its exit code', () => {
  const script = join(import.meta.dir, 'hdiutil-retry.ts');
  const result = Bun.spawnSync([process.execPath, script, import.meta.dir, '--', process.execPath, '-e', 'console.log("bundling"); process.exit(3)'], {
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  });
  expect(result.stdout.toString()).toContain('bundling');
  expect(result.exitCode).toBe(3);
});
