// apps/shell/src-tauri/windows/stop-shell.ps1, which the installer hooks run
// to find and end the shell of their own install, by its full path.
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve(import.meta.dir, '../../apps/shell/src-tauri/windows/stop-shell.ps1');
const root = process.platform === 'win32' ? mkdtempSync(join(tmpdir(), 'boite stop-shell-')) : '';
const started: Bun.Subprocess[] = [];

afterAll(async () => {
  for (const child of started) { child.kill(); await child.exited; }
  if (root) rmSync(root, { recursive: true, force: true });
});

/** A process running `name` from `directory`: Bun under the shell's file name. */
function shell(directory: string, name: string): Bun.Subprocess {
  mkdirSync(directory, { recursive: true });
  copyFileSync(process.execPath, join(directory, name));
  const child = Bun.spawn([join(directory, name), '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  started.push(child);
  return child;
}

function run(directory: string, names: string, action: 'find' | 'stop') {
  return Bun.spawn(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    env: { ...process.env, BOITE_SHELL_DIR: directory, BOITE_SHELL_NAMES: names, BOITE_SHELL_ACTION: action },
    stdout: 'pipe', stderr: 'pipe', windowsHide: true,
  }).exited;
}

describe.skipIf(process.platform !== 'win32')('installer shell stop', () => {
  test('only the shell running from the install directory is found and ended', async () => {
    const install = join(root, 'Boite Dev');
    const other = shell(join(root, 'Boite'), 'boite-stoptest-shell.exe');
    const renamed = shell(install, 'boite-stoptest-shell.exe');
    await Bun.sleep(300);

    // This build's name: nothing of it runs here, and the same name elsewhere does not count.
    expect(await run(install, 'boite-stoptest-dev-shell.exe|', 'find')).toBe(1);
    expect(await run(join(root, 'Boite'), 'boite-stoptest-dev-shell.exe|', 'find')).toBe(1);
    // A registered name may not leave the install directory.
    expect(await run(install, `boite-stoptest-dev-shell.exe|..\\Boite\\boite-stoptest-shell.exe`, 'find')).toBe(1);
    expect(await run(install, 'boite-stoptest-dev-shell.exe|..\\Boite\\boite-stoptest-shell.exe', 'stop')).toBe(0);
    expect(other.exitCode).toBeNull();

    // The name the previous install registered.
    expect(await run(install, 'boite-stoptest-dev-shell.exe|boite-stoptest-shell.exe', 'find')).toBe(0);
    expect(await run(install, 'boite-stoptest-dev-shell.exe|boite-stoptest-shell.exe', 'stop')).toBe(0);
    await renamed.exited;
    expect(await run(install, 'boite-stoptest-dev-shell.exe|boite-stoptest-shell.exe', 'find')).toBe(1);
    expect(other.exitCode).toBeNull();
  }, 60_000);
});
