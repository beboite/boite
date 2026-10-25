import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseBase, previousApk } from './android-apk.ts';
import { SOURCES, VERSION_FILE, previousServerApk, serverApkVersion, serverNextVersion } from './android-server-apk.ts';

const asset = (name: string) => ({ name });

test('each app reuses its own APK when a release carries both', () => {
  const releases = [
    { tag_name: 'v2.0.0-nightly.20261027.1', draft: true, assets: [asset('boite-server-android-1.0.2.apk')] },
    { tag_name: 'v2.0.0-nightly.20261026.1', draft: false, assets: [asset('boite-server-android-1.0.1-unsigned.apk'), asset('boite-android-1.0.4.apk')] },
    { tag_name: 'v2.0.0-nightly.20261025.1', draft: false, assets: [asset('boite-android-1.0.3.apk'), asset('boite-server-android-1.0.0.apk')] },
  ];
  expect(previousServerApk(releases)).toEqual({ tag: 'v2.0.0-nightly.20261025.1', name: 'boite-server-android-1.0.0.apk' });
  expect(previousApk(releases)).toEqual({ tag: 'v2.0.0-nightly.20261026.1', name: 'boite-android-1.0.4.apk' });
  expect(previousServerApk([{ tag_name: 'v2.0.0', draft: false, assets: [asset('boite-android-1.0.3.apk')] }])).toBeNull();
});

test('the server app counts its own version from its own VERSION', () => {
  const base = parseBase(readFileSync(VERSION_FILE, 'utf8'), VERSION_FILE);
  expect(base).toEqual({ major: 1, minor: 0 });
  expect(serverNextVersion(base, null)).toEqual({ major: 1, minor: 0, patch: 0 });
  expect(serverNextVersion(base, 'boite-server-android-1.0.3.apk')).toEqual({ major: 1, minor: 0, patch: 4 });
  expect(serverApkVersion('boite-android-1.0.3.apk')).toBeNull();
  // An error names the file to raise, not the Boite app's.
  expect(() => serverNextVersion(base, 'boite-server-android-1.2.0.apk')).toThrow(`${VERSION_FILE} holds 1.0, below the published 1.2.0`);
  expect(() => parseBase('1', VERSION_FILE)).toThrow(`${VERSION_FILE} must hold MAJOR.MINOR`);
});

test('a change to the Termux scripts alone keeps the published APK', () => {
  // The same pathspec the reuse probe diffs: a typo in the exclusion would rebuild every night, or never.
  const files = Bun.spawnSync(['git', 'ls-files', '--', ...SOURCES], { stdout: 'pipe' }).stdout.toString().split('\n').filter(Boolean);
  expect(files).toContain('apps/android-server/app/build.gradle.kts');
  expect(files).toContain('apps/android-server/VERSION');
  expect(files.filter((file) => file.startsWith('apps/android-server/termux/'))).toEqual([]);
});
