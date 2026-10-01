import { expect, test } from 'bun:test';
import { TARGETS, releaseFiles, updaterManifest } from './updater-manifest';

const version = '2.0.0-nightly.20260922.1';
const names = [
  `Boite_${version}_x64-setup.exe`,
  `Boite_${version}_amd64.AppImage`, `Boite_${version}_aarch64.AppImage`,
  `Boite_${version}_amd64.deb`, `Boite_${version}_arm64.deb`,
  `Boite_${version}_x64.app.tar.gz`, `Boite_${version}_aarch64.app.tar.gz`,
  `boite-server_${version}_x64.zip`, `boite-server_${version}_arm64.zip`,
];
const signed = names.map((file) => ({ file, signature: 'c2lnbmF0dXJl\n' }));

test('manifest binds every platform payload to the exact immutable release tag', () => {
  const result = updaterManifest(version, 'beboite/boite', signed, 'Changes', '2026-09-22T03:23:00Z');
  expect(Object.keys(result.platforms).sort()).toEqual(TARGETS.map(([target]) => target).sort());
  expect(result.platforms['windows-x86_64']).toEqual({ signature: 'c2lnbmF0dXJl', url: `https://github.com/beboite/boite/releases/download/v${version}/Boite_${version}_x64-setup.exe` });
  // An AppImage and a .deb of one architecture must never receive each other's payload.
  expect(result.platforms['linux-aarch64-deb']!.url).toEndWith('_arm64.deb');
  expect(result.platforms['linux-aarch64-appimage']!.url).toEndWith('_aarch64.AppImage');
  expect(result.platforms['darwin-x86_64']!.url).toEndWith('_x64.app.tar.gz');
  expect(result.notes).toBe('Changes');
});

test('unsigned, incomplete or ambiguous release inputs cannot produce a manifest', () => {
  const date = '2026-09-22';
  expect(() => updaterManifest('2.0.0', 'beboite/boite', signed.map((p, i) => (i ? p : { ...p, signature: '' })), '', date)).toThrow('signature');
  expect(() => updaterManifest('../main', 'beboite/boite', signed, '', date)).toThrow('semantic version');
  expect(() => updaterManifest('2.0.0', 'beboite/boite', [...signed.slice(1), { file: '../Boite_x64-setup.exe', signature: 'YWJj' }], '', date)).toThrow('filename');
  expect(() => updaterManifest('2.0.0', 'beboite/boite', signed.slice(0, -1), '', date)).toThrow('linux-aarch64-server');
  expect(() => updaterManifest('2.0.0', 'beboite/boite', [...signed, signed[0]!], '', date)).toThrow('second payload');
});

test('a release directory holds only known payloads, their signatures and manual downloads', () => {
  const files = [...names, ...names.map((file) => `${file}.sig`), `Boite_${version}_x64.dmg`, `Boite_${version}_aarch64.dmg`, 'release-notes.md'];
  expect(releaseFiles(files)).toEqual({ payloads: [...names].sort(), downloads: [`Boite_${version}_aarch64.dmg`, `Boite_${version}_x64.dmg`] });
  expect(() => releaseFiles([...files, 'Boite-macos.zip'])).toThrow('Boite-macos.zip');
  expect(() => releaseFiles([...files, 'Boite.dmg.sig'])).toThrow('without an updater payload');
});
