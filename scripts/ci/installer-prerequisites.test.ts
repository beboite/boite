import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installerPrerequisites } from './installer-prerequisites.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('optional unsupported-platform runs skip while complete Windows fixtures are ready', () => {
  const root = mkdtempSync(join(tmpdir(), 'boite-installer-prerequisites-'));
  dirs.push(root);
  const env = { LOCALAPPDATA: join(root, 'local'), CARGO_TARGET_DIR: join(root, 'cargo') };
  const paths = installerPrerequisites({ root, platform: 'linux', env });
  expect(paths.ready).toBe(false);
  mkdirSync(paths.plugins, { recursive: true });
  mkdirSync(paths.generated, { recursive: true });
  for (const path of [paths.makensis, ...['installer.nsi', 'utils.nsh', 'FileAssociation.nsh'].map(file => join(paths.generated, file))]) {
    writeFileSync(path, 'fixture');
  }
  expect(installerPrerequisites({ root, platform: 'linux', env }).ready).toBe(false);
  expect(installerPrerequisites({ root, platform: 'win32', env: { ...env, BOITE_CI_INSTALLER_REQUIRED: '1' } }).ready).toBe(true);
  rmSync(join(paths.generated, 'utils.nsh'));
  expect(() => installerPrerequisites({ root, platform: 'win32', env: { ...env, BOITE_CI_INSTALLER_REQUIRED: '1' } }))
    .toThrow(`${join(paths.generated, 'utils.nsh')}: missing`);
});

test('explicitly required installer suites fail for missing prerequisites instead of skipping', () => {
  const missing = mkdtempSync(join(tmpdir(), 'boite-installer-missing-'));
  dirs.push(missing);
  for (const file of ['installer-hooks.test.ts', 'installer-shortcuts.test.ts']) {
    const result = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, file)], {
      env: { ...process.env, BOITE_CI_INSTALLER_REQUIRED: '1', LOCALAPPDATA: missing, CARGO_TARGET_DIR: missing },
      stdout: 'pipe', stderr: 'pipe', windowsHide: true,
    });
    expect(result.exitCode).not.toBe(0);
    const output = result.stdout.toString() + result.stderr.toString();
    expect(output).toContain('BOITE_CI_INSTALLER_REQUIRED=1');
    expect(output).toContain(join(missing, 'tauri', 'NSIS', 'makensis.exe'));
    expect(output).toContain(join(missing, 'release', 'nsis', 'x64', 'installer.nsi'));
  }
});
