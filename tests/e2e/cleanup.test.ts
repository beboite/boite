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
  const holder = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command',
    `$f = [IO.File]::Open('${file}', 'Open', 'ReadWrite', 'None'); 'locked'; Start-Sleep -Milliseconds 3500; $f.Close()`],
  { stdout: 'pipe', stderr: 'ignore', windowsHide: true });
  try {
    const reader = holder.stdout.getReader();
    let said = '';
    while (!said.includes('locked')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('the lock holder exited before it held the file');
      said += new TextDecoder().decode(chunk.value);
    }
    expect(await removeDirectory(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
  } finally {
    holder.kill();
    await holder.exited;
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
