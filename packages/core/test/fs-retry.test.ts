import { existsSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { removeDir } from '../src/fs-retry.ts';

const holders: ReturnType<typeof Bun.spawn>[] = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) {
    holder.kill();
    await holder.exited;
  }
});

/** A process whose working directory is `dir` for `ms`, which is what keeps Windows from deleting it. */
async function hold(dir: string, ms: number): Promise<ReturnType<typeof Bun.spawn>> {
  const holder = Bun.spawn([process.execPath, '-e', `console.log('ready'); setTimeout(() => {}, ${ms})`], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'ignore',
    windowsHide: true,
  });
  holders.push(holder);
  const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader();
  await reader.read();
  reader.releaseLock();
  return holder;
}

test('a directory a leaving process still holds is removed once it lets go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-fs-retry-'));
  await hold(dir, 600);
  if (process.platform === 'win32') {
    // What the three readers relied on: Bun's rm tries once, whatever maxRetries says.
    await expect(rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })).rejects.toThrow(/EBUSY/);
  }
  const logged: string[] = [];
  expect(await removeDir(dir, (message) => logged.push(message))).toBe(true);
  expect(existsSync(dir)).toBe(false);
  expect(logged).toEqual([]);
});

test('a directory still held after the last attempt is logged and left, and nothing throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'boite-fs-retry-'));
  const holder = await hold(dir, 5000);
  const logged: string[] = [];
  const removed = await removeDir(dir, (message) => logged.push(message), 2, 10);
  if (process.platform === 'win32') {
    expect(removed).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(logged[0]).toContain(dir);
    expect(logged[0]).toContain('EBUSY');
  }
  holder.kill();
  await holder.exited;
  expect(await removeDir(dir)).toBe(true);
  expect(existsSync(dir)).toBe(false);
});
