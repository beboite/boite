import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * An agent on Windows runs `boite` from PowerShell or cmd. A `.cmd` file always
 * goes through cmd.exe, which ends the command at an unquoted `&` that
 * PowerShell passes bare: `boite browser open "https://a.test/?a=1&b=2" --profile
 * private` lost everything after the `&` and opened the page in the default
 * profile (2026-10-22). `boite.exe` beside the `.cmd` takes precedence and hands
 * each argument to the core as it came.
 */
const launcher = resolve('apps/shell/src-tauri/binaries/boite.exe');
const required = process.env.BOITE_CI_INSTALLER_REQUIRED === '1';

test.skipIf(process.platform !== 'win32' || (!required && !existsSync(launcher)))(
  'the installed CLI on Windows passes an argument holding & through PowerShell and cmd', () => {
  const directory = mkdtempSync(join(tmpdir(), 'boite-cli-windows-'));
  try {
    // The installed layout: the runtime as boite-core.exe, the bundle in core\, both shims.
    copyFileSync(process.execPath, join(directory, 'boite-core.exe'));
    mkdirSync(join(directory, 'core'));
    writeFileSync(join(directory, 'core', 'main.js'), 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    copyFileSync(resolve('packages/core/shims/boite.cmd'), join(directory, 'boite.cmd'));
    copyFileSync(launcher, join(directory, 'boite.exe'));
    // Windows names it `Path`; a second `PATH` beside it would not be the one read.
    // An inherited BOITE_CORE_EXECUTABLE would run another core than the one staged here.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !['PATH', 'BOITE_CORE_EXECUTABLE'].includes(name.toUpperCase())));
    env.Path = `${directory};${process.env.Path ?? process.env.PATH ?? ''}`;
    // Verbatim, so cmd.exe reads the line as typed rather than with escaped quotes.
    const run = (command: string[]) => {
      const result = Bun.spawnSync(command, { cwd: directory, env, stdout: 'pipe', stderr: 'pipe', windowsHide: true, windowsVerbatimArguments: true });
      return { code: result.exitCode, out: result.stdout.toString().trim(), err: result.stderr.toString().trim() };
    };
    const expected = JSON.stringify(['cli', 'browser', 'open', 'https://a.test/?a=1&b=2', '--profile', 'private']);
    expect(run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `"boite browser open 'https://a.test/?a=1&b=2' --profile private"`]))
      .toEqual({ code: 0, out: expected, err: '' });
    expect(run(['cmd.exe', '/d', '/c', 'boite browser open "https://a.test/?a=1&b=2" --profile private']))
      .toEqual({ code: 0, out: expected, err: '' });
    // A space and an exit code come through too.
    expect(run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', `"boite panel 'a file.txt'"`]).out).toBe(JSON.stringify(['cli', 'panel', 'a file.txt']));
    writeFileSync(join(directory, 'core', 'main.js'), 'process.exit(7);\n');
    expect(run(['cmd.exe', '/d', '/c', 'boite status']).code).toBe(7);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
