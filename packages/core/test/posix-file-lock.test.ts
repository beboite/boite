import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { posixLockFile } from '../src/platform/posix-file-lock.ts';

test.skipIf(process.platform === 'win32')('a POSIX lock rejects contention and can be acquired again after release', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'boite-posix-lock-'));
  const file = join(dir, 'core.lock');
  const lock = posixLockFile(process.platform === 'darwin' ? 'macos' : 'linux');
  let held: ReturnType<typeof lock> = null;
  try {
    held = lock(file);
    expect(held).not.toBeNull();
    expect(lock(file)).toBeNull();
    held!.write('owner');
    expect(fs.readFileSync(file, 'utf8')).toBe('owner');
    held!.release();
    held = lock(file);
    expect(held).not.toBeNull();
  } finally {
    held?.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform === 'win32')('a lock is not still at a path on another device with the same inode', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'boite-posix-lock-'));
  const file = join(dir, 'core.lock');
  const held = posixLockFile(process.platform === 'darwin' ? 'macos' : 'linux')(file)!;
  const realStat = fs.statSync;
  let replaced = false;
  const stat = spyOn(fs, 'statSync').mockImplementation(((path: fs.PathLike, options?: object) => {
    const found = realStat(path, options as never);
    if (String(path) !== file || !replaced) return found;
    return new Proxy(found, {
      get(target, key) {
        if (key === 'dev') return (target.dev as unknown as bigint) + 1n;
        return Reflect.get(target, key, target);
      },
    });
  }) as never);
  try {
    expect(held.stillAt(file)).toBe(true);
    replaced = true;
    expect(held.stillAt(file)).toBe(false);
  } finally {
    stat.mockRestore(); held.release();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
