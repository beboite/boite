import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ASSETLINKS, apkHost, assetlinksDigest, previousApk, signerDigest } from './android-apk.ts';

test('the APK to reuse is the newest published signed one, never a draft or an unsigned build', () => {
  const asset = (name: string) => ({ name });
  expect(previousApk([
    { tag_name: 'v2.0.0-nightly.20261002.1', draft: true, assets: [asset('boite-2.0.0-nightly.20261002.1.apk')] },
    { tag_name: 'v2.0.0-nightly.20261001.1', draft: false, assets: [asset('boite-2.0.0-nightly.20261001.1-unsigned.apk'), asset('latest.json')] },
    { tag_name: 'v2.0.0-nightly.20260930.2', draft: false, assets: [asset('Boite_2.0.0_x64-setup.exe'), asset('boite-2.0.0-nightly.20260929.1.apk')] },
    { tag_name: 'v2.0.0-nightly.20260929.1', draft: false, assets: [asset('boite-2.0.0-nightly.20260929.1.apk')] },
  ])).toEqual({ tag: 'v2.0.0-nightly.20260930.2', name: 'boite-2.0.0-nightly.20260929.1.apk' });
  expect(previousApk([{ tag_name: 'v2.0.0', draft: false, assets: [] }])).toBeNull();
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
