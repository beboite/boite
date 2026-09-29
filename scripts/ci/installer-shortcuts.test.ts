import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const NSIS = join(process.env.LOCALAPPDATA ?? '', 'tauri', 'NSIS');
const GENERATED = join(process.env.CARGO_TARGET_DIR ?? join(ROOT, 'apps/shell/src-tauri/target'), 'release/nsis/x64');
const ready = process.platform === 'win32' && existsSync(join(NSIS, 'makensis.exe')) && existsSync(join(GENERATED, 'utils.nsh'));
// Windows runners can expose TEMP through an 8.3 profile path. Shell links
// store its expanded spelling, which the NSIS target comparison expects.
const scratch = ready ? realpathSync.native(mkdtempSync(join(tmpdir(), 'boite-shortcuts-'))) : '';
const running = new Set<Bun.Subprocess>();
afterAll(async () => {
  for (const child of running) { child.kill(); await child.exited; }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const template = readFileSync(join(ROOT, 'apps/shell/src-tauri/windows/installer.nsi'), 'utf8').replaceAll('\r\n', '\n');
function nsisFunction(name: string) {
  const start = template.indexOf(`Function ${name}\n`);
  if (start < 0) throw new Error(`installer.nsi: missing function ${name}`);
  return template.slice(start, template.indexOf('FunctionEnd', start) + 'FunctionEnd'.length);
}

// Run the shipped NSIS functions with their real COM shortcut helpers. Only
// the shell folders and registry namespace are redirected into this fixture.
describe.skipIf(!ready)('installer shortcuts', () => {
  let setup: string;
  function build() {
    if (setup) return;
    setup = join(scratch, 'setup.exe');
    const removeStart = template.indexOf('  ; Remove shortcuts if not updating');
    const removeEnd = template.indexOf('  ; Remove registry information', removeStart);
    expect(removeStart).toBeGreaterThan(0);
    expect(removeEnd).toBeGreaterThan(removeStart);
    const remove = template.slice(removeStart, removeEnd)
      .replace(/^.*!insertmacro MUI_STARTMENU_GETFOLDER.*$/m, '    StrCpy $AppStartMenuFolder ""');
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
      'Var PassiveMode', 'Var UpdateMode', 'Var NoShortcutMode', 'Var WixMode',
      'Var OldMainBinaryName', 'Var AppStartMenuFolder',
      nsisFunction('.onInit'), nsisFunction('RestorePreviousInstallLocation'),
      nsisFunction('CreateOrUpdateStartMenuShortcut'), nsisFunction('CreateOrUpdateDesktopShortcut'),
      finishAction === 'CreateOrUpdateDesktopShortcut' ? '' : nsisFunction(finishAction),
      'Section Install',
      '  StrCpy $OldMainBinaryName "boite-shortcut-test.exe"',
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
  async function run(exe: string, args: string[]) {
    const child = Bun.spawn([exe, '/S', ...args], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    running.add(child);
    const code = await child.exited;
    running.delete(child);
    expect(code).toBe(0);
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
});
