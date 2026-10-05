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
  expect(watchdogsOfThisProcess()).toEqual([]);
}, 60_000);

/** Read-only: the parent-death watchdogs this process started and that still run. */
function watchdogsOfThisProcess(): string[] {
  if (process.platform === 'win32') return [];
  const listed = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid=,args=']).stdout.toString();
  return listed.split('\n').map((line) => line.trim().split(/\s+/))
    .filter(([, ppid, ...args]) => ppid === String(process.pid) && args.includes('boite-e2e-watchdog'))
    .map(([pid]) => pid ?? '');
}

test.skipIf(process.platform === 'win32')('a test process killed outright takes its browsers and profiles with it', async () => {
  // Without the watchdog, Chrome is reparented to init when its test process
  // dies and runs on with its profile: what leaked 2.4 GB on 2026-10-05.
  const script = `import { BrowserPage } from ${JSON.stringify(join(import.meta.dir, 'lib', 'cdp.ts'))};
const pages = await Promise.all([0, 1].map(() => BrowserPage.launch({ url: 'about:blank' })));
console.log(JSON.stringify(pages.map((page) => ({ pid: page.pid, profile: page.profileDir }))));
setInterval(() => {}, 60_000);`;
  // Outside the checkout: the child must not load the suite's preload.
  const child = Bun.spawn({ cmd: [process.execPath, '-e', script], cwd: tmpdir(), stdout: 'pipe', stderr: 'pipe' });
  let launched: { pid: number; profile: string }[] = [];
  try {
    const reader = child.stdout.getReader();
    let out = '';
    while (!out.includes('\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`the child exited before launching: ${await new Response(child.stderr).text()}`);
      out += new TextDecoder().decode(chunk.value);
    }
    launched = JSON.parse(out.slice(0, out.indexOf('\n'))) as typeof launched;
    expect(launched.map(({ pid }) => alive(pid))).toEqual([true, true]);

    child.kill('SIGKILL');
    await child.exited;
    const deadline = Date.now() + 10_000;
    const left = () => launched.filter(({ pid, profile }) => alive(pid) || existsSync(profile));
    while (left().length > 0 && Date.now() < deadline) await Bun.sleep(100);
    expect(left()).toEqual([]);
  } finally {
    child.kill('SIGKILL');
    // Only pids this test captured, and only if the watchdog failed.
    for (const { pid } of launched) if (alive(pid)) process.kill(pid, 'SIGKILL');
    // Its renderers still write for a moment after the browser goes.
    for (const { profile } of launched) await removeDirectory(profile, 5_000);
  }
}, 60_000);
