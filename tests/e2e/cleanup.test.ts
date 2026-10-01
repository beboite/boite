import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserPage } from './lib/cdp.ts';
import { E2E_DIR_PREFIX, removeDirectory, sweepStaleDirectories } from './lib/cleanup.ts';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.skipIf(process.platform !== 'win32')('a directory still locked for a few seconds is removed once the lock goes', async () => {
  const dir = mkdtempSync(join(tmpdir(), `${E2E_DIR_PREFIX}locked-`));
  const file = join(dir, 'Cookies');
  writeFileSync(file, 'held');
  // What a Chromium still exiting does to its profile: a file open with no
  // sharing, which no delete gets through until the process lets go.
  // Hold the native handle here: PowerShell startup and its stdout pipe made
  // the readiness handshake hang before this test even reached removal.
  const { dlopen, FFIType, ptr } = await import('bun:ffi');
  const api = dlopen('kernel32.dll', {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  });
  const path = Buffer.from(`${file}\0`, 'utf16le');
  // GENERIC_READ, no sharing, OPEN_EXISTING. HANDLE is an integer, not an FFI pointer.
  const handle = api.symbols.CreateFileW(ptr(path), 0x80000000, 0, null, 3, 0, 0);
  if (BigInt(handle) === 0xffffffffffffffffn) {
    const error = api.symbols.GetLastError();
    api.close();
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`CreateFileW could not lock ${file}: Windows error ${error}`);
  }
  let held = true;
  const release = () => {
    if (held) api.symbols.CloseHandle(handle);
    held = false;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(() => rmSync(dir, { recursive: true, force: true })).toThrow();
    timer = setTimeout(release, 3_500);
    expect(await removeDirectory(dir)).toBe(true);
    expect(held).toBe(false);
    expect(existsSync(dir)).toBe(false);
  } finally {
    clearTimeout(timer);
    release();
    api.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test('the sweep takes only harness directories an hour old, never a live one or a stranger', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-sweep-root-'));
  try {
    const old = join(root, `${E2E_DIR_PREFIX}browser-old`);
    const fresh = join(root, `${E2E_DIR_PREFIX}browser-fresh`);
    const stranger = join(root, 'someone-else-old');
    for (const dir of [old, fresh, stranger]) mkdirSync(dir);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    utimesSync(stranger, twoHoursAgo, twoHoursAgo);

    expect(sweepStaleDirectories(root)).toBe(1);
    expect([existsSync(old), existsSync(fresh), existsSync(stranger)]).toEqual([false, true, true]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pages closed together leave no profile and no browser behind', async () => {
  const pages = await Promise.all([0, 1, 2].map(() => BrowserPage.launch({ url: 'about:blank' })));
  const profiles = pages.map((page) => page.profileDir ?? '');
  const pids = pages.map((page) => page.pid ?? 0);
  expect(profiles.every((dir) => existsSync(dir))).toBe(true);

  await Promise.all(pages.map((page) => page.close()));

  expect(profiles.filter((dir) => existsSync(dir))).toEqual([]);
  expect(pids.filter(alive)).toEqual([]);
}, 60_000);
