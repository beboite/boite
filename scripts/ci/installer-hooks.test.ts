// The Windows installer hooks (apps/shell/src-tauri/windows/hooks.nsh), built
// with the NSIS Tauri downloaded and run silently over processes this test
// starts. It needs what a Windows `bun run build:shell` leaves behind: makensis
// under %LOCALAPPDATA%\tauri\NSIS and the generated installer.nsi under the
// cargo target directory (CARGO_TARGET_DIR, else apps/shell/src-tauri/target).
// Without them it skips locally and fails when BOITE_CI_INSTALLER_REQUIRED=1.
// Nothing it runs opens a window: the installers
// are silent and every process is started hidden.
import { afterAll, describe, expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { installerPrerequisites } from './installer-prerequisites.ts';

const ROOT = resolve(import.meta.dir, '../..');
const HOOKS = join(ROOT, 'apps/shell/src-tauri/windows/hooks.nsh');
const { nsis: NSIS, makensis: MAKENSIS, plugins: PLUGINS, generated: GENERATED, ready } = installerPrerequisites({ root: ROOT });

const scratch = ready ? mkdtempSync(join(tmpdir(), 'boite-hooks-')) : '';
const started: number[] = [];
// Where the hook test installer reads the previous install's MainBinaryName.
const UNINSTKEY = 'Software\\Boite hook test';

function kill(pid: number) {
  try { process.kill(pid, 0); } catch { return; }
  Bun.spawnSync(['taskkill', '/T', '/F', '/PID', String(pid)], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
}

afterAll(async () => {
  for (const pid of started) kill(pid);
  if (ready) Bun.spawnSync(['reg', 'delete', `HKCU\\${UNINSTKEY}`, '/f'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
  // Windows lets go of a killed process's executable a moment after taskkill
  // returns: the copies under the scratch directory stay locked until then.
  for (let attempt = 0; scratch; attempt++) {
    try {
      rmSync(scratch, { recursive: true, force: true });
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== 'EPERM' && code !== 'EBUSY') || attempt >= 40) throw error;
      await Bun.sleep(250);
    }
  }
}, 30_000);

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
        // Only hook placement is under test: omit application/WebView payloads
        // even when the build's files still exist, and disable any compression.
        .replace(/^!if "[^"]+" == "none"\r?$/m, '!if "none" == "none"')
        .replace(/^([ \t]*)File [^\r\n]*\r?$/gm, '$1; payload omitted by hook template test');
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
  // first, or that restarted core holds boite-core.exe again. It ends only the
  // shell running from the install's directory: Boite and Boite Dev install
  // side by side, and once shipped the same file name.
  test('a running shell cannot restart the core while its files are replaced or removed', async () => {
    const { base, other, running, bundles, restartedPids, exited, run } = installerFixture('active');
    const installed = await running('install');
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${installed.install}`])).toBe(0);
    // Ended by the installer, whatever code that leaves.
    expect(await exited(installed.shell)).not.toBe('still running');
    // Left on its own, through /shutdown.
    expect(await exited(installed.core)).toBe(0);
    expect(restartedPids(installed.restarted)).toEqual([]);
    expect(existsSync(join(installed.install, 'write-failed'))).toBe(false);
    expect(readFileSync(join(installed.install, 'boite-core.exe'), 'utf8')).toBe('the new core\n');
    expect(bundles(installed.install)).toEqual({ core: false, ui: false, kept: true, aside: false });

    const removed = await running('uninstall');
    // A scanner or an editor holding a chunk, without delete sharing, through
    // the hooks' first pass; it lets go once the template's deletions ran.
    const held = join(removed.install, STALE[0][0]);
    const holding = join(base, 'holding.txt');
    const holder = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `$f = [IO.File]::Open('${held}', 'Open', 'Read', 'Read'); Set-Content '${holding}' 'held';`
        + ` while (Test-Path '${join(removed.install, 'boite-core.exe')}') { Start-Sleep -Milliseconds 50 }; $f.Close()`], {
      stdout: 'ignore', stderr: 'ignore', windowsHide: true,
    });
    started.push(holder.pid);
    for (const deadline = Date.now() + 20_000; !existsSync(holding);) {
      if (Date.now() > deadline) throw new Error('the holder never opened its file');
      await Bun.sleep(50);
    }
    expect(await run([join(base, 'uninstall.exe'), '/S', `_?=${removed.install}`])).toBe(0);
    expect(await exited(holder)).toBe(0);
    // Ended by the installer, whatever code that leaves.
    expect(await exited(removed.shell)).not.toBe('still running');
    expect(await exited(removed.core)).toBe(0);
    expect(restartedPids(removed.restarted)).toEqual([]);
    expect(existsSync(join(removed.install, 'boite-core.exe'))).toBe(false);
    expect(bundles(removed.install)).toEqual({ core: false, ui: false, kept: true, aside: false });
    // A matching shell name in another installation stays running.
    expect(other.exitCode).toBeNull();
  }, 180_000);

  test('failed and renamed installs preserve the core and its bundles', async () => {
    const { base, data, other, running, bundles, restartedPids, exited, run } = installerFixture('recovery');
    const busy = await running('busy');
    writeFileSync(join(data, 'boite2', 'busy'), '');
    const before = Bun.hash(readFileSync(join(busy.install, 'boite-core.exe')));
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${busy.install}`])).not.toBe(0);
    expect(busy.core.exitCode).toBeNull();
    expect(Bun.hash(readFileSync(join(busy.install, 'boite-core.exe')))).toBe(before);
    // Refused before anything was removed: a working core still loads its chunks.
    expect(bundles(busy.install)).toEqual({ core: true, ui: true, kept: true, aside: false });
    expect(restartedPids(busy.restarted)).toEqual([]);

    // A copy that fails halfway through the chunks, once the core stopped and
    // the previous build was moved aside: its chunks come back where that
    // core, never overwritten, loads them, and the new build's partial
    // directory goes.
    rmSync(join(data, 'boite2', 'busy'), { force: true });
    const failed = await running('failed');
    const failedCore = Bun.hash(readFileSync(join(failed.install, 'boite-core.exe')));
    writeFileSync(join(failed.install, 'fail-copy'), '');
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${failed.install}`])).not.toBe(0);
    expect(await exited(failed.shell)).not.toBe('still running');
    expect(await exited(failed.core)).toBe(0);
    expect(restartedPids(failed.restarted)).toEqual([]);
    expect(bundles(failed.install)).toEqual({ core: true, ui: true, kept: true, aside: false });
    for (const [path, text] of STALE) expect(readFileSync(join(failed.install, path), 'utf8')).toBe(text);
    expect(existsSync(join(failed.install, 'core', 'main-n3wn3wn3.js'))).toBe(false);
    expect(Bun.hash(readFileSync(join(failed.install, 'boite-core.exe')))).toBe(failedCore);

    // An interrupted run left core.previous, and a scanner holds a file in it
    // without delete sharing: that leftover cannot go, so this run leaves core
    // where it is, and a failed copy must not put the leftover in its place.
    const leftover = await running('leftover');
    const interrupted = join(leftover.install, 'core.previous', 'main-1nt3rrup.js');
    mkdirSync(dirname(interrupted), { recursive: true });
    writeFileSync(interrupted, 'interrupted run');
    const holdingLeftover = join(base, 'holding-leftover.txt');
    const release = join(base, 'release-leftover.txt');
    const leftoverHolder = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `$f = [IO.File]::Open('${interrupted}', 'Open', 'Read', 'Read'); Set-Content '${holdingLeftover}' 'held';`
        + ` while (-not (Test-Path '${release}')) { Start-Sleep -Milliseconds 50 }; $f.Close()`], {
      stdout: 'ignore', stderr: 'ignore', windowsHide: true,
    });
    started.push(leftoverHolder.pid);
    for (const deadline = Date.now() + 20_000; !existsSync(holdingLeftover);) {
      if (Date.now() > deadline) throw new Error('the holder never opened the leftover');
      await Bun.sleep(50);
    }
    writeFileSync(join(leftover.install, 'fail-copy'), '');
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${leftover.install}`])).not.toBe(0);
    writeFileSync(release, '');
    expect(await exited(leftoverHolder)).toBe(0);
    expect(await exited(leftover.shell)).not.toBe('still running');
    expect(await exited(leftover.core)).toBe(0);
    expect(restartedPids(leftover.restarted)).toEqual([]);
    for (const [path, text] of STALE) expect(readFileSync(join(leftover.install, path), 'utf8')).toBe(text);
    expect(existsSync(join(leftover.install, 'core', 'main-1nt3rrup.js'))).toBe(false);

    // An install made before a rename (Boite Dev's boite-shell.exe): the
    // shell still runs under the name that install registered.
    const registered = Bun.spawnSync(['reg', 'add', `HKCU\\${UNINSTKEY}`, '/v', 'MainBinaryName', '/d', 'boite-hooktest-old-shell.exe', '/f'], {
      stdout: 'ignore', stderr: 'pipe', windowsHide: true,
    });
    expect(registered.exitCode).toBe(0);
    rmSync(join(data, 'boite2', 'busy'), { force: true });
    const renamed = await running('renamed', 'boite-hooktest-old-shell.exe');
    expect(await run([join(base, 'setup.exe'), '/S', `/D=${renamed.install}`])).toBe(0);
    expect(await exited(renamed.shell)).not.toBe('still running');
    expect(await exited(renamed.core)).toBe(0);
    expect(restartedPids(renamed.restarted)).toEqual([]);
    // A matching shell name in another installation stays running.
    expect(other.exitCode).toBeNull();
  }, 180_000);

  test('idle installs skip stop scripts and a stale lock takes the checked path', async () => {
    const { base, data, other, bundles, exited } = installerFixture('idle');
    // Nothing of the install runs, as after an in-app update stopped its core
    // and its shell: no PowerShell starts. Each one took about a second on
    // Windows 11, most of an update's installation (2026-10-23). The scripts
    // write their names to BOITE_HOOKS_TRACE when they run.
    function idle(name: string) {
      const install = join(base, name);
      mkdirSync(install, { recursive: true });
      copyFileSync(process.execPath, join(install, 'boite-core.exe'));
      copyFileSync(process.execPath, join(install, 'boite-hooktest-shell.exe'));
      for (const [path, text] of [...STALE, ...KEPT]) {
        mkdirSync(dirname(join(install, path)), { recursive: true });
        writeFileSync(join(install, path), text);
      }
      return install;
    }
    const trace = join(base, 'hooks-trace.txt');
    async function traced(install: string) {
      rmSync(trace, { force: true });
      const at = performance.now();
      // Handed over explicitly: a child started without `env` does not see a later change to process.env.
      const child = Bun.spawn([join(base, 'setup.exe'), '/S', `/D=${install}`], {
        env: { ...process.env, BOITE_HOOKS_TRACE: trace }, stdout: 'ignore', stderr: 'ignore', windowsHide: true,
      });
      started.push(child.pid);
      expect(await child.exited).toBe(0);
      const scripts = existsSync(trace) ? readFileSync(trace, 'utf8').split(/\r?\n/).filter(Boolean) : [];
      return { scripts, ms: Math.round(performance.now() - at) };
    }
    rmSync(join(data, 'boite2', 'core.lock'), { force: true });
    const quiet = idle('idle');
    const idleRun = await traced(quiet);
    console.log(`an install with nothing running took ${idleRun.ms} ms, 6000 of them the section's own sleep`);
    expect(idleRun.scripts).toEqual([]);
    expect(readFileSync(join(quiet, 'boite-core.exe'), 'utf8')).toBe('the new core\n');
    expect(bundles(quiet)).toEqual({ core: false, ui: false, kept: true, aside: false });

    // The in-app update's shell exits just after starting the installer: a
    // shell executable let go of within the 3 seconds still skips the scripts.
    const exiting = idle('exiting');
    const exitingShell = join(exiting, 'boite-hooktest-shell.exe');
    const holdingShell = join(base, 'holding-shell.txt');
    // The paths go through the environment, so an apostrophe in them cannot end a PowerShell string.
    const shellHolder = Bun.spawn(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      "$f = [IO.File]::Open($env:BOITE_HOLD_FILE, 'Open', 'Read', 'Read'); Set-Content -LiteralPath $env:BOITE_HOLD_SIGNAL 'held'; Start-Sleep -Milliseconds 1000; $f.Close()"], {
      env: { ...process.env, BOITE_HOLD_FILE: exitingShell, BOITE_HOLD_SIGNAL: holdingShell }, stdout: 'ignore', stderr: 'ignore', windowsHide: true,
    });
    started.push(shellHolder.pid);
    for (const deadline = Date.now() + 20_000; !existsSync(holdingShell);) {
      if (Date.now() > deadline) throw new Error('the holder never opened the shell executable');
      await Bun.sleep(50);
    }
    const exitingRun = await traced(exiting);
    expect(await exited(shellHolder)).toBe(0);
    expect(exitingRun.scripts).toEqual([]);
    expect(readFileSync(join(exiting, 'boite-core.exe'), 'utf8')).toBe('the new core\n');

    // A lock a crashed core left behind takes the checked way, at once, which finds nothing to stop.
    writeFileSync(join(data, 'boite2', 'core.lock'), JSON.stringify({ pid: 999999, startedAt: Date.now() }));
    const crashed = idle('crashed');
    const crashedRun = await traced(crashed);
    expect(crashedRun.scripts).toEqual(['stop-shell', 'stop-core']);
    expect(readFileSync(join(crashed, 'boite-core.exe'), 'utf8')).toBe('the new core\n');
    rmSync(join(data, 'boite2', 'core.lock'), { force: true });
    // A matching shell name in another installation stays running.
    expect(other.exitCode).toBeNull();
  }, 180_000);
});

/** An isolated installation tree, data directory and compiled hooks for one scenario group. */
function installerFixture(name: string) {
  const base = join(scratch, name);
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, 'fake-core.ts'), FAKE_CORE);
  writeFileSync(join(base, 'fake-shell.ts'), FAKE_SHELL);
  writeFileSync(join(base, 'new-core.txt'), 'the new core\n');
  const data = join(base, 'data');
  mkdirSync(join(data, 'boite2'), { recursive: true });
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
    `!define UNINSTKEY "${UNINSTKEY}"`,
    'Var PassiveMode',
    'Var OldMainBinaryName',
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
    // The user reading the template's OK/Cancel box, when it still asks.
    '  Sleep 6000',
    '  !ifndef BOITE_HOOKS_CLOSE_SHELL',
    '    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
    '  !endif',
    // A copy that fails halfway through the chunks, which the template
    // writes before boite-core.exe (a full disk): the install aborts.
    '  IfFileExists "$INSTDIR\\fail-copy" 0 +4',
    '    CreateDirectory "$INSTDIR\\core"',
    `    File "/oname=core\\main-n3wn3wn3.js" "${join(base, 'new-core.txt')}"`,
    '    Abort',
    '  ClearErrors',
    `  File "/oname=boite-core.exe" "${join(base, 'new-core.txt')}"`,
    '  IfErrors 0 +2',
    '    FileOpen $0 "$INSTDIR\\write-failed" w',
    `  WriteUninstaller "${join(base, 'uninstall.exe')}"`,
    '  !insertmacro NSIS_HOOK_POSTINSTALL',
    'SectionEnd',
    'Section Uninstall',
    '  !insertmacro NSIS_HOOK_PREUNINSTALL',
    '  Sleep 6000',
    '  !ifndef BOITE_HOOKS_CLOSE_SHELL',
    '    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"',
    '  !endif',
    '  Delete "$INSTDIR\\boite-core.exe"',
    // The rest of the template's uninstall: shortcuts, registry, uninstaller.
    '  Sleep 2000',
    // Where the template inserts it, after its own deletions.
    '  !ifmacrodef NSIS_HOOK_POSTUNINSTALL',
    '    !insertmacro NSIS_HOOK_POSTUNINSTALL',
    '  !endif',
    'SectionEnd',
  ].join('\r\n');
  writeFileSync(join(base, 'hooktest.nsi'), script);
  makensis(join(base, 'hooktest.nsi'));
  // No name left registered by an earlier run.
  Bun.spawnSync(['reg', 'delete', `HKCU\\${UNINSTKEY}`, '/f'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });

  // The same file name run from elsewhere: another install, or a build in a
  // cargo target directory. No installer here may end it.
  const elsewhere = join(base, 'elsewhere');
  mkdirSync(elsewhere, { recursive: true });
  copyFileSync(process.execPath, join(elsewhere, 'boite-hooktest-shell.exe'));
  const other = Bun.spawn([join(elsewhere, 'boite-hooktest-shell.exe'), '-e', 'setInterval(() => {}, 1000)'], {
    stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  started.push(other.pid);

  // An install and its running core and shell, as Boite leaves them.
  async function running(name: string, shellName = 'boite-hooktest-shell.exe') {
    const install = join(base, name);
    mkdirSync(install, { recursive: true });
    mkdirSync(join(data, 'boite2'), { recursive: true });
    rmSync(join(data, 'boite2', 'core.json'), { force: true });
    copyFileSync(process.execPath, join(install, 'boite-core.exe'));
    copyFileSync(process.execPath, join(install, shellName));
    // A previous build's hashed chunks, and files of the user's beside them.
    for (const [path, text] of [...STALE, ...KEPT]) {
      mkdirSync(dirname(join(install, path)), { recursive: true });
      writeFileSync(join(install, path), text);
    }
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
    const shell = Bun.spawn([join(install, shellName), join(base, 'fake-shell.ts'),
      join(install, 'boite-core.exe'), join(base, 'fake-core.ts'), join(data, 'boite2'), restarted], {
      stdout: 'ignore', stderr: 'ignore', windowsHide: true,
    });
    started.push(shell.pid);
    await Bun.sleep(500);
    return { install, core, shell, restarted };
  }
  // Whether the bundle directories are still there, the user's files
  // untouched and nothing left aside.
  function bundles(install: string) {
    return {
      core: existsSync(join(install, 'core')),
      ui: existsSync(join(install, 'ui')),
      kept: KEPT.every(([path, text]) => existsSync(join(install, path)) && readFileSync(join(install, path), 'utf8') === text),
      aside: existsSync(join(install, 'core.previous')) || existsSync(join(install, 'ui.previous')),
    };
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
  return { base, data, other, running, bundles, restartedPids, exited, run };
}

/** What an earlier build left in the install's two bundle directories. */
const STALE = [['core/main-0ld0ld0l.js', 'old chunk'], ['ui/assets/index-0ld0ld0l.js', 'old asset'], ['ui/index.html', 'old page']] as const;
/** Beside them, outside those directories: nothing the hooks may delete. */
const KEPT = [['notes.txt', 'mine'], ['core-notes/notes.txt', 'mine too'], ['uikit/notes.txt', 'mine as well']] as const;

/** Writes core.json into its --data-dir and leaves on an authorised POST /shutdown. */
const FAKE_CORE = `
import { existsSync } from 'node:fs';
const dir = process.argv[process.argv.indexOf('--data-dir') + 1];
const token = 'hook-token';
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === '/shutdown-if-idle' && existsSync(dir + '/busy')) return new Response('busy', { status: 409 });
  if ((url.pathname === '/shutdown' || url.pathname === '/shutdown-if-idle' && url.searchParams.get('pid') === String(process.pid)) && request.method === 'POST' && request.headers.get('authorization') === 'Bearer ' + token) {
    setTimeout(() => process.exit(0), 20);
    return Response.json({ ok: true, pid: process.pid }, { status: 202 });
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
