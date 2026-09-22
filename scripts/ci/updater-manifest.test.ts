import { expect, test } from 'bun:test';
import { updaterManifest } from './updater-manifest';

test('manifest binds the signed installer to the exact immutable release tag', () => {
  const result = updaterManifest('2.0.0-nightly.20260922.1', 'beboite/boite', 'Boite setup.exe', 'c2lnbmF0dXJl\n', 'Changes', '2026-09-22T03:23:00Z');
  expect(result.platforms['windows-x86_64']).toEqual({ signature: 'c2lnbmF0dXJl', url: 'https://github.com/beboite/boite/releases/download/v2.0.0-nightly.20260922.1/Boite%20setup.exe' });
  expect(result.notes).toBe('Changes');
});

test('unsigned or ambiguous release inputs cannot produce a manifest', () => {
  expect(() => updaterManifest('2.0.0', 'beboite/boite', 'Boite.exe', '', '', '2026-09-22')).toThrow('signature');
  expect(() => updaterManifest('../main', 'beboite/boite', 'Boite.exe', 'YWJj', '', '2026-09-22')).toThrow('semantic version');
  expect(() => updaterManifest('2.0.0', 'beboite/boite', '../Boite.exe', 'YWJj', '', '2026-09-22')).toThrow('filename');
});
