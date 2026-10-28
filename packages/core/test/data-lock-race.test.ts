import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { lockDataDir, takeLock } from '../src/data-lock.ts';
import { removeDir } from './harness.ts';

/*
 * Two cores starting on one directory, each in its own process, stopped at
 * explicit barriers inside the lock: the clock readings `takeLock` asks for
 * are the hooks. `holder` is asked while judging a record left by an older
 * run, `own` once this process holds the lock and before it writes its record.
 */
const dirs: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const dir of dirs.splice(0)) await removeDir(dir);
});

function waitFor(paths: string[]): string {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = paths.find(path => existsSync(path));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`none of ${paths.join(', ')} appeared`);
    Bun.sleepSync(5);
  }
}

function contender(dir: string, name: string) {
  const signal = (stage: string) => join(dir, `${name}-${stage}`);
  const script = `
    const { existsSync, writeFileSync } = await import('node:fs');
    const { takeLock } = await import(${JSON.stringify(join(import.meta.dir, '../src/data-lock.ts'))});
    const signal = (stage) => ${JSON.stringify(join(dir, name))} + '-' + stage;
    const pause = (stage) => {
      writeFileSync(signal(stage), '');
      const deadline = Date.now() + 10000;
      while (!existsSync(signal('go-' + stage)) && Date.now() < deadline) Bun.sleepSync(5);
    };
    let result;
    try {
      takeLock(${JSON.stringify(join(dir, 'core.lock'))}, (pid) => 'busy ' + pid, {
        startedAt: () => null,
        bootedAt: () => 0,
        startKey: (pid) => { pause(pid === process.pid ? 'own' : 'holder'); return pid === process.pid ? null : 'another-run'; },
      });
      result = 'admitted';
    } catch (error) { result = error.message; }
    writeFileSync(signal('result'), result);
    setInterval(() => {}, 1000);`;
  children.push(Bun.spawn([process.execPath, '-e', script], { stdout: 'ignore', stderr: 'inherit', windowsHide: true }));
  return {
    /** Waits until it pauses at `stage` or has its answer; true when it paused there. */
    reached: (stage: string) => waitFor([signal(stage), signal('result')]) === signal(stage),
    go: (stage: string) => writeFileSync(signal(`go-${stage}`), ''),
    result: () => { waitFor([signal('result')]); return readFileSync(signal('result'), 'utf8'); },
  };
}

test('a core that holds the lock before it wrote its record keeps it from a second core', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-lock-race-'));
  dirs.push(dir);
  const first = contender(dir, 'first');
  expect(first.reached('own')).toBe(true);
  // The lock is taken and the record not yet written: the file reads empty.
  expect(() => lockDataDir(dir)).toThrow(`another core is already running on ${dir}`);
  first.go('own');
  expect(first.result()).toBe('admitted');
  expect(() => lockDataDir(dir)).toThrow(`another core is already running on ${dir}`);
});

test('two cores reclaiming one stale lock never both hold it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-lock-race-'));
  dirs.push(dir);
  // A record from an earlier run whose pid is now worn by another live process.
  writeFileSync(join(dir, 'core.lock'), JSON.stringify({ pid: process.ppid, startedAt: 0, startKey: 'earlier-run' }), 'utf8');
  const both = [contender(dir, 'a'), contender(dir, 'b')];
  const judging = both.filter(each => each.reached('holder'));
  // One at a time: each reclaims, then stops before it writes its record.
  for (const each of judging) {
    each.go('holder');
    each.reached('own');
  }
  for (const each of both) each.go('own');
  const results = both.map(each => each.result());
  expect(results.filter(result => result === 'admitted')).toHaveLength(1);
  expect(results.filter(result => result.startsWith('busy'))).toHaveLength(1);
});

test('a core older than this lock that replaces the file before the record is written keeps its directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-lock-race-'));
  dirs.push(dir);
  const file = join(dir, 'core.lock');
  // An older core holds nothing but the file: it unlinks a record it judged stale and writes its own.
  const older = JSON.stringify({ pid: process.ppid, startedAt: Date.now(), startKey: 'older-run' });
  let replaced = false;
  expect(() => takeLock(file, holder => `busy ${holder}`, {
    startedAt: () => null,
    bootedAt: () => 0,
    startKey: (pid) => {
      if (pid !== process.pid) return 'older-run';
      // Locked and judged, the record not yet written: the older core replaces the path now.
      if (!replaced) { replaced = true; rmSync(file); writeFileSync(file, older, 'utf8'); }
      return null;
    },
  })).toThrow(`busy ${process.ppid}`);
  expect(readFileSync(file, 'utf8')).toBe(older);
});
