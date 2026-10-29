import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installerPrerequisites } from './installer-prerequisites.ts';

const ROOT = resolve(import.meta.dir, '../..');
const { nsis: NSIS, generated: GENERATED, ready } = installerPrerequisites({ root: ROOT });
// Windows runners can expose TEMP through an 8.3 profile path. Shell links
// store its expanded spelling, which the NSIS target comparison expects.
const scratch = ready ? realpathSync.native(mkdtempSync(join(tmpdir(), 'boite-shortcuts-'))) : '';
const running = new Set<Bun.Subprocess>();
/** One install, update or uninstall of the fixture: a fraction of a second when nothing stalls. */
const RUN_DEADLINE_MS = 10_000;
let slowest = 0, runSequence = 0;
const phaseTrace = join(scratch, 'native-phases.log');
// Where the fixture records its MainBinaryName, as the template does under its uninstall key.
const UNINSTKEY = 'Software\\Boite shortcut test uninstall';
afterAll(async () => {
  if (slowest) console.log(`slowest installer run: ${slowest} ms`);
  for (const child of running) { child.kill(); await child.exited; }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  if (ready) Bun.spawnSync(['reg', 'delete', `HKCU\\${UNINSTKEY}`, '/f'], { stdout: 'ignore', stderr: 'ignore', windowsHide: true });
});

const template = readFileSync(join(ROOT, 'apps/shell/src-tauri/windows/installer.nsi'), 'utf8').replaceAll('\r\n', '\n');
function nsisFunction(name: string) {
  const start = template.indexOf(`Function ${name}\n`);
  if (start < 0) throw new Error(`installer.nsi: missing function ${name}`);
  return template.slice(start, template.indexOf('FunctionEnd', start) + 'FunctionEnd'.length);
}

function tracedFunction(name: string) {
  return nsisFunction(name).split('\n').flatMap((line, index) => {
    const label = `${name}:${index}`;
    const trace = (phase: string) => `  !insertmacro TracePhase "${phase}"`;
    if (line.startsWith('Function ')) return [line, trace(`${name}:enter`)];
    if (line === 'FunctionEnd') return [trace(`${name}:leave`), line];
    if (line.trim() === 'Return') return [trace(`${label}:return`), line];
    if (/^\s*(?:CreateShortcut |!insertmacro (?:IsShortcutTarget|SetShortcutTarget|SetLnkAppUserModelId) )/.test(line)) {
      return [trace(`${label}:before`), line, trace(`${label}:after`)];
    }
    return [line];
  }).join('\n');
}

// Run the shipped NSIS functions with their real COM shortcut helpers. The
// shell folders and registry namespace are redirected into this fixture, and
// the uninstall's unpin and jump list calls are recorded in shell-calls.txt
// instead of reaching this machine's Start menu and taskbar.
describe.skipIf(!ready)('installer shortcuts', () => {
  let setup: string;
  function build() {
    if (setup) return;
    setup = join(scratch, 'setup.exe');
    const removeStart = template.indexOf('  ; Remove shortcuts if not updating');
    const removeEnd = template.indexOf('  ; Remove registry information', removeStart);
    expect(removeStart).toBeGreaterThan(0);
    expect(removeEnd).toBeGreaterThan(removeStart);
    // Unpinning and clearing jump lists reach this machine's own Start menu
    // and taskbar, which no redirection covers: the fixture records them
    // instead. Both CI hangs ran out of time in this uninstall (#707,
    // 2026-10-21, and #731, 2026-10-23), whose only calls into another
    // process are these.
    const record = (call: string) => `    FileOpen $9 "$INSTDIR\\shell-calls.txt" a\n    FileSeek $9 0 END\n    FileWrite $9 "${call}$\\n"\n    FileClose $9`;
    const remove = template.slice(removeStart, removeEnd)
      .replace(/^.*!insertmacro MUI_STARTMENU_GETFOLDER.*$/m, '    StrCpy $AppStartMenuFolder ""')
      .replace(/^\s*!insertmacro DeleteAppUserModelId\s*$/m, record('jump lists'))
      .replace(/^\s*!insertmacro UnpinShortcut "([^"]+)"\s*$/gm, (_line, link: string) => record(`unpin ${link}`));
    expect(remove).not.toContain('!insertmacro UnpinShortcut');
    expect(remove).not.toContain('!insertmacro DeleteAppUserModelId');
    const finishAction = template.match(/^!define MUI_FINISHPAGE_SHOWREADME_FUNCTION (\w+)$/m)![1]!;
    const script = [
      'Unicode true', 'SetCompress off', 'RequestExecutionLevel user', 'SilentInstall silent',
      `OutFile "${setup}"`,
      '!include MUI2.nsh', '!include FileFunc.nsh', '!include x64.nsh',
      '!include "Win\\COM.nsh"', '!include "Win\\Propkey.nsh"',
      `!include "${join(GENERATED, 'utils.nsh')}"`,
      '!define PRODUCTNAME "Boite shortcut test"', '!define MAINBINARYNAME "boite-shortcut-test"',
      '!define BUNDLEID "com.boite.shortcut-test"', '!define INSTALLMODE "currentUser"',
      '!define ARCH "x64"', '!define DISPLAYLANGUAGESELECTOR "false"', '!define STARTMENUFOLDER ""',
      '!define PLACEHOLDER_INSTALL_DIR "unused"',
      '!define MANUPRODUCTKEY "Software\\Boite shortcut test"',
      `!define UNINSTKEY "${UNINSTKEY}"`,
      'Var PassiveMode', 'Var UpdateMode', 'Var NoShortcutMode', 'Var WixMode',
      'Var OldMainBinaryName', 'Var AppStartMenuFolder',
      // Tracing saves its scratch registers and the incoming error flag. In
      // particular IsShortcutTarget leaves a result on the NSIS stack.
      '!macro TracePhase LABEL',
      '  Push $8', '  Push $9',
      '  ${If} ${Errors}', '    StrCpy $8 1', '  ${Else}', '    StrCpy $8 0', '  ${EndIf}',
      '  ClearErrors', `  FileOpen $9 "${phaseTrace}" a`,
      '  ${IfNot} ${Errors}', '    FileSeek $9 0 END', '    FileWrite $9 "${LABEL}$\\n"', '    FileClose $9', '  ${EndIf}',
      '  ${If} $8 = 1', '    SetErrors', '  ${Else}', '    ClearErrors', '  ${EndIf}',
      '  Pop $9', '  Pop $8', '!macroend',
      tracedFunction('.onInit'), nsisFunction('RestorePreviousInstallLocation'),
      tracedFunction('CreateOrUpdateStartMenuShortcut'), tracedFunction('CreateOrUpdateDesktopShortcut'),
      finishAction === 'CreateOrUpdateDesktopShortcut' ? '' : tracedFunction(finishAction),
      'Section Install',
      // What the template's Install section does with the registered name.
      '  ReadRegStr $OldMainBinaryName SHCTX "${UNINSTKEY}" "MainBinaryName"',
      '  WriteRegStr SHCTX "${UNINSTKEY}" "MainBinaryName" "boite-shortcut-test.exe"',
      '  FileOpen $0 "$INSTDIR\\boite-shortcut-test.exe" w', '  FileWrite $0 "new version"', '  FileClose $0',
      '  CreateDirectory "$INSTDIR\\start-menu"', '  CreateDirectory "$INSTDIR\\desktop"',
      '  Call CreateOrUpdateStartMenuShortcut', '  Call CreateOrUpdateDesktopShortcut',
      '  ${GetOptions} $CMDLINE "/REQUESTSHORTCUT" $0',
      '  ${IfNot} ${Errors}', `    Call ${finishAction}`, '  ${EndIf}',
      '  FileOpen $0 "$INSTDIR\\mode.txt" w', '  FileWrite $0 $UpdateMode', '  FileClose $0',
      '  WriteUninstaller "$INSTDIR\\uninstall.exe"', 'SectionEnd',
      'Section Uninstall', remove, 'SectionEnd',
    ].join('\n').replaceAll('$SMPROGRAMS', '$INSTDIR\\start-menu').replaceAll('$DESKTOP', '$INSTDIR\\desktop');
    const file = join(scratch, 'shortcuts.nsi');
    writeFileSync(file, script);
    const built = Bun.spawnSync([join(NSIS, 'makensis.exe'), '/V4', file], { windowsHide: true });
    if (built.exitCode !== 0) throw new Error(built.stdout.toString() + built.stderr.toString());
  }
  // Each run gets its own deadline, so a stall names the run instead of timing the whole test out.
  async function run(exe: string, args: string[]) {
    const runId = ++runSequence;
    writeFileSync(phaseTrace, '');
    const child = Bun.spawn([exe, '/S', ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    running.add(child);
    const at = Date.now();
    // Drain both streams immediately, retaining only their final 4 KiB. Do
    // not await EOF: descendants could inherit a pipe beyond this run's exit.
    const drain = (stream: ReadableStream<Uint8Array>) => {
      const reader = stream.getReader();
      let tail = Buffer.alloc(0), readError = false;
      const done = (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            tail = Buffer.concat([tail, value]).subarray(-4096);
          }
        } catch { readError = true; }
        finally { reader.releaseLock(); }
      })();
      return { snapshot: () => ({ tail: tail.toString('utf8'), readError }),
        close: () => { void reader.cancel().catch(() => {}); void done; } };
    };
    const stdout = drain(child.stdout), stderr = drain(child.stderr);
    let code: number | 'stalled' | undefined;
    try {
      code = await Promise.race([child.exited, Bun.sleep(RUN_DEADLINE_MS).then(() => 'stalled' as const)]);
      if (code === 'stalled') {
        throw new Error(`${exe} /S ${args.join(' ')} had not exited after ${RUN_DEADLINE_MS} ms`);
      }
      slowest = Math.max(slowest, Date.now() - at);
      expect(code).toBe(0);
    } catch (error) {
      // Read while the timed-out child is still alive, before owned cleanup.
      // Only fixed labels from this fixture are written to the small trace.
      let trace: string;
      try { trace = readFileSync(phaseTrace, 'utf8').slice(-8192); }
      catch { trace = 'trace unavailable'; }
      console.error('installer fixture failure', JSON.stringify({ runId, pid: child.pid, exe, args,
        elapsedMs: Date.now() - at, exit: child.exitCode, result: code ?? 'rejected',
        lastPhase: trace.trim().split(/\r?\n/).at(-1) ?? null, trace,
        stdout: stdout.snapshot(), stderr: stderr.snapshot() }));
      throw error;
    } finally {
      if (code === 'stalled') {
        // Awaited, so the killed run lets go of its directory before the next one or the cleanup.
        child.kill(); await child.exited;
      }
      if (code !== undefined) running.delete(child);
      stdout.close(); stderr.close();
      // Keep each run's trace until the existing scratch cleanup, with its ID.
      try { renameSync(phaseTrace, join(scratch, `run-${runId}-phases.log`)); }
      catch { console.error('installer fixture trace could not be archived', runId); }
    }
  }
  for (const [name, flags] of [['manual', []], ['in-app', ['/UPDATE']]] as const) {
    test(`${name} update preserves shortcuts and a real uninstall removes them`, async () => {
      build();
      const install = join(scratch, name);
      mkdirSync(install);
      await run(setup, [`/D=${install}`]);
      expect(readFileSync(join(install, 'mode.txt'), 'utf8')).not.toBe('1');
      const links = ['start-menu', 'desktop'].map(folder => join(install, folder, 'Boite shortcut test.lnk'));
      const before = links.map(path => ({ bytes: readFileSync(path), modified: statSync(path).mtimeMs }));
      await run(setup, [...flags, `/D=${install}`]);
      expect(readFileSync(join(install, 'mode.txt'), 'utf8')).toBe('1');
      for (const [index, path] of links.entries()) {
        expect(readFileSync(path)).toEqual(before[index]!.bytes);
        expect(statSync(path).mtimeMs).toBe(before[index]!.modified);
      }
      await run(join(install, 'uninstall.exe'), [`_?=${install}`]);
      for (const path of links) expect(existsSync(path)).toBe(false);
      // The real uninstall's shell calls, each still made once per link.
      // An empty Start menu folder leaves a doubled separator in the first path the template tries.
      expect(readFileSync(join(install, 'shell-calls.txt'), 'utf8').replace(/\\+/g, '\\').split(/\r?\n/).filter(Boolean))
        .toEqual(['jump lists', `unpin ${links[0]}`, `unpin ${links[1]}`]);
      rmSync(join(install, 'shell-calls.txt'));

      // A user who removed these links must not get new ones on an update.
      await run(setup, [...flags, `/D=${install}`]);
      for (const path of links) expect(existsSync(path)).toBe(false);

      // The finish-page checkbox is an explicit request, including /NS.
      await run(setup, [...flags, '/NS', '/REQUESTSHORTCUT', `/D=${install}`]);
      expect(readFileSync(join(install, 'mode.txt'), 'utf8')).toBe('1');
      expect(existsSync(links[0]!)).toBe(false);
      expect(existsSync(links[1]!)).toBe(true);
      const requested = statSync(links[1]!).mtimeMs;
      await run(setup, [...flags, '/REQUESTSHORTCUT', `/D=${install}`]);
      expect(statSync(links[1]!).mtimeMs).toBe(requested);
    }, 30_000);
  }

  // Boite Dev shipped boite-shell.exe, then boite-dev-shell.exe. Its next
  // installer, downloaded by hand, must update that install in place (not run
  // its old uninstaller first) and point the existing links at the new file.
  test('an install made under an earlier binary name is updated and its links follow', async () => {
    build();
    const install = join(scratch, 'renamed');
    const old = join(install, 'boite-old-shortcut-test.exe');
    const links = ['start-menu', 'desktop'].map(folder => join(install, folder, 'Boite shortcut test.lnk'));
    for (const folder of ['start-menu', 'desktop']) mkdirSync(join(install, folder), { recursive: true });
    writeFileSync(old, 'old version');
    const made = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject WScript.Shell; foreach ($l in @('${links.join("','")}')) { $k = $s.CreateShortcut($l); $k.TargetPath = '${old}'; $k.Save() }`,
    ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(made.exitCode).toBe(0);
    const registered = Bun.spawnSync(['reg', 'add', `HKCU\\${UNINSTKEY}`, '/v', 'MainBinaryName', '/d', 'boite-old-shortcut-test.exe', '/f'], {
      stdout: 'ignore', stderr: 'pipe', windowsHide: true,
    });
    expect(registered.exitCode).toBe(0);

    await run(setup, [`/D=${install}`]);
    expect(readFileSync(join(install, 'mode.txt'), 'utf8')).toBe('1');
    const targets = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-Command',
      `$s = New-Object -ComObject WScript.Shell; foreach ($l in @('${links.join("','")}')) { $s.CreateShortcut($l).TargetPath }`,
    ], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    expect(targets.stdout.toString().trim().split(/\r?\n/)).toEqual([0, 1].map(() => join(install, 'boite-shortcut-test.exe')));
  }, 30_000);
});
