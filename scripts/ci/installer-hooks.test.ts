// The Windows installer hooks (apps/shell/src-tauri/windows/hooks.nsh), built
// with the NSIS Tauri downloaded and run silently over processes this test
// starts. It needs what a Windows `bun run build:shell` leaves behind: makensis
// under %LOCALAPPDATA%\tauri\NSIS and the generated installer.nsi under the
// cargo target directory (CARGO_TARGET_DIR, else apps/shell/src-tauri/target).
// Without them it is skipped. Nothing it runs opens a window: the installers
// are silent and every process is started hidden.
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const HOOKS = join(ROOT, 'apps/shell/src-tauri/windows/hooks.nsh');
const NSIS = join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS');
const MAKENSIS = join(NSIS, 'makensis.exe');
const PLUGINS = join(NSIS, 'Plugins', 'x86-unicode', 'additional');
const TARGET = process.env.CARGO_TARGET_DIR ?? join(ROOT, 'apps/shell/src-tauri/target');
const GENERATED = join(TARGET, 'release', 'nsis', 'x64');
const ready = process.platform === 'win32' && existsSync(MAKENSIS) && existsSync(join(GENERATED, 'installer.nsi'));

const scratch = ready ? mkdtempSync(join(tmpdir(), 'boite-hooks-')) : '';
const started: number[] = [];

function kill(pid: number) {
  Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
}

afterAll(() => {
  for (const pid of started) kill(pid);
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function makensis(script: string): string {
  const built = Bun.spawnSync([MAKENSIS, '/V4', script], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const output = built.stdout.toString() + built.stderr.toString();
  if (built.exitCode !== 0) throw new Error(`makensis ${script} failed:\n${output.slice(-4000)}`);
  return output;
}

describe.skipIf(!ready)('installer hooks', () => {
  // Tauri's template includes the hooks before it defines BUNDLEID: the data
  // directory has to be chosen inside the macro, where the section inserts it.
  test('the Dev installer stops the core of the Dev data directory', () => {
    // Without its byte order mark, which a line put before it would strand.
    const generated = readFileSync(join(GENERATED, 'installer.nsi'), 'utf8').replace(/^﻿/, '');
    const include = `!include "${HOOKS}"`;
    // A build made with the hooks already names a copy of them: this
    // checkout's are put in its place, where the template put that one.
    const existing = /^!include ".*hooks\.nsh"\r?$/m;
    const withHooks = existing.test(generated)
      ? generated.replace(existing, include)
      : generated.replace(/^\$\{StrLoc\}\r?$/m, (line) => `${line}\n\n${include}`);
    expect(withHooks.indexOf(include)).toBeGreaterThan(0);
    expect(withHooks.indexOf(include)).toBeLessThan(withHooks.indexOf('!define BUNDLEID'));
    for (const [id, name] of [['com.boite.two', 'boite2'], ['com.boite.two.dev', 'boite2-dev']]) {
      const directory = join(scratch, `template-${id}`);
      mkdirSync(directory, { recursive: true });
      for (const file of ['utils.nsh', 'FileAssociation.nsh']) copyFileSync(join(GENERATED, file), join(directory, file));
      const script = `!addplugindir /x86-unicode "${PLUGINS}"\n` + withHooks
        .replace(/^!define BUNDLEID ".*"\r?$/m, `!define BUNDLEID "${id}"`)
        .replace(/^!define OUTFILE ".*"\r?$/m, `!define OUTFILE "${join(directory, 'setup.exe')}"`)
        // Only the script is under test: no compression, and the payload
        // files a build staged need not exist any more.
        .replace('!if "lzma" == "none"', '!if "none" == "none"')
        .replace(/^(\s*)File (?!\/nonfatal)/gm, '$1File /nonfatal ');
      writeFileSync(join(directory, 'installer.nsi'), script);
      const output = makensis(join(directory, 'installer.nsi'));
      const chosen = [...output.matchAll(/SetEnvironmentVariable\(t "BOITE_STOP_DIR", t "([^"]*)"\)/g)].map((match) => match[1]);
      // Once in the installer, once in the uninstaller.
      expect(chosen).toEqual([`$LOCALAPPDATA\\${name}`, `$LOCALAPPDATA\\${name}`]);
    }
  }, 120_000);

  // A running shell brings its core back within seconds of losing it
  // (LOCAL_RECOVERY_MS in the UI), while the template's own check waits on
  // an OK/Cancel box before it ends the shell. The hook must end the shell
  // first, or that restarted core holds boite-core.exe again.
  test('a running shell cannot restart the core while its files are replaced or removed', async () => {
    const base = join(scratch, 'shell');
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'fake-core.ts'), FAKE_CORE);
    writeFileSync(join(base, 'fake-shell.ts'), FAKE_SHELL);
    writeFileSync(join(base, 'new-core.txt'), 'the new core\n');
    copyFileSync(process.execPath, join(base, 'boite-hooktest-shell.exe'));
    const data = join(base, 'data');
    const script = [
      'Unicode true',
      `!addplugindir /x86-unicode "${PLUGINS}"`,
      '!include LogicLib.nsh',
      `!include "${join(GENERATED, 'utils.nsh')}"`,
      `!define BOITE_DATA_ROOT "${data}"`,
      // Where and in which order the template has them.
      `!include "${HOOKS}"`,
      '!define MAINBINARYNAME "boite-hooktest-shell"',
      '!define PRODUCTNAME "Boite hook test"',
      '!define BUNDLEID "com.boite.two"',
      '!define INSTALLMODE "currentUser"',
      'Var PassiveMode',
      `OutFile "${join(base, 'setup.exe')}"`,
      'RequestExecutionLevel user',
      'SilentInstall silent',
      'LoadLanguageFile "${NSISDIR}\\Contrib\\Language files\\English.nlf"',
      'LangString appRunning ${LANG_ENGLISH} "{{product_name}} is running"',
      'LangString appRunningOkKill ${LANG_ENGLISH} "{{product_name}} is running, OK to kill it"',
      'LangString failedToKillApp ${LANG_ENGLISH} "{{product_name}} could not be killed"',
      'Section Install',
      '  SetOutPath $INSTDIR',
      '  !insertmacro NSIS_HOOK_PREINSTALL',
      // The user reading the template's OK/Cancel box.
      '  Sleep 6000',
      '  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
      '  ClearErrors',
      `  File "/oname=boite-core.exe" "${join(base, 'new-core.txt')}"`,
      '  IfErrors 0 +2',
      '    FileOpen $0 "$INSTDIR\\write-failed" w',
      `  WriteUninstaller "${join(base, 'uninstall.exe')}"`,
      'SectionEnd',
      'Section Uninstall',
      '  !insertmacro NSIS_HOOK_PREUNINSTALL',
      '  Sleep 6000',
      '  !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
      '  Delete "$INSTDIR\\boite-core.exe"',
      'SectionEnd',
    ].join('\r\n');
    writeFileSync(join(base, 'hooktest.nsi'), script);
    makensis(join(base, 'hooktest.nsi'));

    // An install and its running core and shell, as Boite leaves them.
    async function running(name: string) {
      const install = join(base, name);
      mkdirSync(install, { recursive: true });
      mkdirSync(join(data, 'boite2'), { recursive: true });
      rmSync(join(data, 'boite2', 'core.json'), { force: true });
      copyFileSync(process.execPath, join(install, 'boite-core.exe'));
      const restarted = join(install, 'restarted.txt');
      const core = Bun.spawn([join(install, 'boite-core.exe'), join(base, 'fake-core.ts'), '--data-dir', join(data, 'boite2')], {
        stdout: 'ignore', stderr: 'ignore', windowsHide: true,
      });
      started.push(core.pid);
      const deadline = Date.now() + 20_000;
      while (!existsSync(join(data, 'boite2', 'core.json'))) {
        if (Date.now() > deadline) throw new Error('the fake core never wrote core.json');
        await Bun.sleep(50);
      }
      const shell = Bun.spawn([join(base, 'boite-hooktest-shell.exe'), join(base, 'fake-shell.ts'),
        join(install, 'boite-core.exe'), join(base, 'fake-core.ts'), join(data, 'boite2'), restarted], {
        stdout: 'ignore', stderr: 'ignore', windowsHide: true,
      });
      started.push(shell.pid);
      await Bun.sleep(500);
      return { install, core, shell, restarted };
    }
    function restartedPids(file: string): number[] {
      if (!existsSync(file)) return [];
      const pids = readFileSync(file, 'utf8').split(/\s+/).filter(Boolean).map(Number);
      started.push(...pids);
      return pids;
    }
    // The exit code, or 'still running' after a few seconds.
    function exited(child: Bun.Subprocess, ms = 5_000) {
      return Promise.race([child.exited, Bun.sleep(ms).then(() => 'still running' as const)]);
    }
    async function run(command: string[]) {
      const child = Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
      started.push(child.pid);
      return child.exited;
    }

    const installed = await running('install');
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${installed.install}`])).toBe(0);
    // Ended by the installer, whatever code that leaves.
    expect(await exited(installed.shell)).not.toBe('still running');
    // Left on its own, through /shutdown.
    expect(await exited(installed.core)).toBe(0);
    expect(restartedPids(installed.restarted)).toEqual([]);
    expect(existsSync(join(installed.install, 'write-failed'))).toBe(false);
    expect(readFileSync(join(installed.install, 'boite-core.exe'), 'utf8')).toBe('the new core\n');

    const removed = await running('uninstall');
    expect(await run([join(base, 'uninstall.exe'), '/S', `_?=${removed.install}`])).toBe(0);
    // Ended by the installer, whatever code that leaves.
    expect(await exited(removed.shell)).not.toBe('still running');
    expect(await exited(removed.core)).toBe(0);
    expect(restartedPids(removed.restarted)).toEqual([]);
    expect(existsSync(join(removed.install, 'boite-core.exe'))).toBe(false);
  }, 120_000);
});

/** Writes core.json into its --data-dir and leaves on an authorised POST /shutdown. */
const FAKE_CORE = `
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
const token = 'hook-token';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/shutdown' && request.method === 'POST' && request.headers.get('authorization') === 'Bearer ' + token) {
    setTimeout(() => process.exit(0), 20);
    return Response.json({ ok: true }, { status: 202 });
  }
  return new Response('no', { status: 401 });
} });
await Bun.write(dir + '/core.json', JSON.stringify({ port: server.port, host: '127.0.0.1', token, pid: process.pid }));
setInterval(() => {}, 1000);
`;

/** What the shell and its UI do with a core that went away: start it again,
 * detached like a resident core, four seconds later. Each pid it starts is
 * written down so the test can see it and end it. */
const FAKE_SHELL = `
import { appendFileSync, readFileSync } from 'node:fs';
const [coreExe, coreScript, dataDir, restarted] = process.argv.slice(2);
const pidOf = () => JSON.parse(readFileSync(dataDir + '/core.json', 'utf8')).pid;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
let pid = pidOf();
let waiting = false;
setInterval(() => {
  if (waiting || alive(pid)) return;
  waiting = true;
  setTimeout(() => {
    const core = Bun.spawn([coreExe, coreScript, '--data-dir', dataDir], { stdout: 'ignore', stderr: 'ignore', windowsHide: true, detached: true });
    appendFileSync(restarted, core.pid + '\\n');
    core.unref();
    pid = core.pid;
    waiting = false;
  }, 4000);
}, 100);
`;
