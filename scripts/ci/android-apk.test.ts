import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  ASSETLINKS,
  VERSION_FILE,
  apkHost,
  assetlinksDigest,
  apkVersion,
  nextVersion,
  parseBase,
  previousApk,
  releaseApk,
  signerDigest,
  versionCode,
} from './android-apk.ts';

test('the APK to reuse is the newest published signed one, never a draft or an unsigned build', () => {
  const asset = (name: string) => ({ name });
  expect(previousApk([
    { tag_name: 'v2.0.0-nightly.20261002.1', draft: true, assets: [asset('boite-2.0.0-nightly.20261002.1.apk')] },
    { tag_name: 'v2.0.0-nightly.20261001.1', draft: false, assets: [asset('boite-2.0.0-nightly.20261001.1-unsigned.apk'), asset('latest.json')] },
    { tag_name: 'v2.0.0-nightly.20260930.2', draft: false, assets: [asset('Boite_2.0.0_x64-setup.exe'), asset('boite-2.0.0-nightly.20260929.1.apk')] },
    { tag_name: 'v2.0.0-nightly.20260929.1', draft: false, assets: [asset('boite-2.0.0-nightly.20260929.1.apk')] },
  ])).toEqual({ tag: 'v2.0.0-nightly.20260930.2', name: 'boite-2.0.0-nightly.20260929.1.apk' });
  expect(previousApk([{ tag_name: 'v2.0.0', draft: false, assets: [] }])).toBeNull();
  // The app's own name, and an older release still found behind a newer one without an APK.
  expect(previousApk([
    { tag_name: 'v2.0.0-nightly.20261020.1', draft: false, assets: [asset('boite-android-1.0.0-unsigned.apk')] },
    { tag_name: 'v2.0.0-nightly.20261019.1', draft: false, assets: [asset('boite-android-1.0.3.apk')] },
  ])).toEqual({ tag: 'v2.0.0-nightly.20261019.1', name: 'boite-android-1.0.3.apk' });
});

test('the app version moves only when the APK is rebuilt', () => {
  const base = parseBase('1.0\n');
  // Reused: the file and the version it carries stay as published.
  expect(releaseApk(base, 'boite-android-1.0.3.apk', true)).toEqual({ name: 'boite-android-1.0.3.apk', version: { major: 1, minor: 0, patch: 3 } });
  expect(releaseApk(base, 'boite-2.0.0-nightly.20261014.1.apk', true).name).toBe('boite-2.0.0-nightly.20261014.1.apk');
  // Rebuilt under the same MAJOR.MINOR: next patch.
  expect(releaseApk(base, 'boite-android-1.0.3.apk', false)).toEqual({ name: 'boite-android-1.0.4.apk', version: { major: 1, minor: 0, patch: 4 } });
  // VERSION raised by hand: patch 0.
  expect(releaseApk(parseBase('1.1'), 'boite-android-1.0.3.apk', false).name).toBe('boite-android-1.1.0.apk');
  expect(releaseApk(parseBase('2.0'), 'boite-android-1.4.7.apk', false).name).toBe('boite-android-2.0.0.apk');
  // The APK named after Boite's release carries no app version: the first one is 1.0.0.
  expect(apkVersion('boite-2.0.0-nightly.20261014.1.apk')).toBeNull();
  expect(releaseApk(base, 'boite-2.0.0-nightly.20261014.1.apk', false).name).toBe('boite-android-1.0.0.apk');
  expect(releaseApk(base, null, false).name).toBe('boite-android-1.0.0.apk');
  // A VERSION below the published app would be an update phones refuse.
  expect(() => nextVersion(base, { major: 1, minor: 2, patch: 0 })).toThrow('below the published 1.2.0');
});

test('the version code orders every app version above the old commit counts', () => {
  expect(versionCode({ major: 1, minor: 0, patch: 0 })).toBe(1_000_000);
  expect(versionCode({ major: 1, minor: 2, patch: 3 })).toBe(1_002_003);
  expect(versionCode({ major: 1, minor: 0, patch: 999 })).toBeLessThan(versionCode({ major: 1, minor: 1, patch: 0 }));
  expect(() => versionCode({ major: 1, minor: 0, patch: 1000 })).toThrow('under 1000');
  expect(() => nextVersion(parseBase('1.0'), { major: 1, minor: 0, patch: 999 })).toThrow('under 1000');
  expect(() => parseBase('1.1000')).toThrow('MINOR must be under 1000');
  expect(() => parseBase('0.9')).toThrow('MAJOR must be 1 to 999');
  expect(() => parseBase('1.0.0')).toThrow('must hold MAJOR.MINOR');
  expect(parseBase(readFileSync(VERSION_FILE, 'utf8'))).toEqual({ major: 1, minor: 0 });
});

test('the host and the signer are read from the tools output', () => {
  const dump = [
    '    resource 0x7f0d002c string/generatorApp',
    '      () "bubblewrap-cli"',
    '    resource 0x7f0d002d string/hostName',
    '      () "boite.example.com"',
  ].join('\n');
  expect(apkHost(dump)).toBe('boite.example.com');
  expect(apkHost('    resource 0x7f0d002c string/generatorApp\n      () "x"')).toBeNull();
  expect(signerDigest('Signer #1 certificate SHA-256 digest: 3cf11e0fAB\n')).toBe('3cf11e0fab');
  expect(signerDigest('V3.0 Signer: certificate SHA-256 digest: 3C:F1:1E\n')).toBe('3cf11e');
  expect(signerDigest('DOES NOT VERIFY\n')).toBeNull();
});

test('the served assetlinks.json names a certificate for the app', () => {
  expect(assetlinksDigest(readFileSync(ASSETLINKS, 'utf8'))).toMatch(/^[0-9a-f]{64}$/);
  expect(() => assetlinksDigest('[]')).toThrow('names no certificate');
});
