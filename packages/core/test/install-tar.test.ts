import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { gunzipSync, gzipSync } from 'fflate';
import type { ProviderInstall } from '@boite/contracts';
import { checkSizes, extractRelease } from '../src/providers/install-unpack.ts';
import { tarball } from './fixtures/tarball.ts';
import { thrown } from './settle.ts';

let root: string;
let release: string;
const file = 'package/bin/opencode.exe';
const bytes = new TextEncoder().encode('test executable');
const install: ProviderInstall = { version: '1.0', format: 'tgz', url: 'https://example.invalid/release.tgz',
  sha256: '0'.repeat(64), archiveBytes: 1, files: [{ path: file, bytes: bytes.length }] };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'boite-install-tar-'));
  release = join(root, 'release');
  mkdirSync(release);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function unpack(archive: Uint8Array): Promise<void> {
  const part = join(root, 'download');
  writeFileSync(part, archive);
  await extractRelease(install, new AbortController().signal, part, release, root);
}

/** Recompute the first header's checksum after deliberately damaging a field. */
function checksum(tar: Uint8Array): void {
  tar.fill(0x20, 148, 156);
  const sum = tar.subarray(0, 512).reduce((total, value) => total + value, 0);
  tar.set(new TextEncoder().encode(`${sum.toString(8).padStart(6, '0')}\0 `), 148);
}

test('tgz refuses a planted ancestor link before creating a directory outside the release', async () => {
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(outside, join(release, 'package'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(await thrown(unpack(tarball([{ name: file, bytes }])))).toThrow('symlink');
  expect(existsSync(join(outside, 'bin'))).toBe(false);
});

test.each(['1', '2'])('tgz skips link type %s at the expected executable path', async type => {
  await unpack(tarball([{ name: file, type }]));
  expect(existsSync(join(release, file))).toBe(false);
  expect(() => checkSizes(install, release)).toThrow(`the archive does not hold ${file}`);
});

test('tgz refuses a non-octal member size even when its header checksum is valid', async () => {
  const tar = gunzipSync(tarball([{ name: file, bytes }]));
  tar.set(new TextEncoder().encode(`${bytes.length.toString(8).padStart(10, '0')}z\0`), 124);
  checksum(tar);
  expect(await thrown(unpack(gzipSync(tar)))).toThrow('number');
});

test('tgz refuses missing member padding', async () => {
  const tar = gunzipSync(tarball([{ name: file, bytes }]));
  expect(await thrown(unpack(gzipSync(tar.subarray(0, 512 + bytes.length))))).toThrow('middle of an entry');
});

test('tgz refuses oversized name metadata before buffering it', async () => {
  const tar = gunzipSync(tarball([{ name: 'LongLink', type: 'L' }]));
  tar.set(new TextEncoder().encode('00010000001\0'), 124);
  checksum(tar);
  expect(await thrown(unpack(gzipSync(tar.subarray(0, 512))))).toThrow('metadata');
});

test('tgz checks GNU long names before opening the following member', async () => {
  expect(await thrown(unpack(tarball([{ name: 'LongLink', type: 'L', bytes: new TextEncoder().encode('../escape\0') },
    { name: file, bytes }])))).toThrow('escape');
  expect(existsSync(join(root, 'escape'))).toBe(false);
});
