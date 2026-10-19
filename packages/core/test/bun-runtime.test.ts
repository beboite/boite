import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeDir } from '../src/fs-retry.ts';
import { bunRuntime, runtimeAsset } from '../bin/bun-runtime.ts';

let cacheRoot: string;
beforeEach(() => { cacheRoot = mkdtempSync(join(tmpdir(), 'boite-bun-runtime-')); });
afterEach(async () => { await removeDir(cacheRoot, () => {}, 50); });

/** A zip of one stored file, as the Bun release archives hold `<asset>/bun`. */
function zipOf(name: string, data: Uint8Array): Uint8Array {
  const path = new TextEncoder().encode(name);
  const crc = Bun.hash.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(path.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(path.length, 28);
  const centralAt = local.length + path.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + path.length, 12); end.writeUInt32LE(centralAt, 16);
  return Buffer.concat([local, path, data, central, path, end]);
}

const target = process.platform === 'win32' ? 'bun-windows-x64-baseline' : 'bun-linux-arm64';
const exe = process.platform === 'win32' ? 'bun.exe' : 'bun';
const asset = runtimeAsset(target);

/** A release server: `stall` takes each request and never answers. */
function release(files: Record<string, Uint8Array | string>, stall = false) {
  const asked: string[] = [];
  const server = Bun.serve({
    port: 0, idleTimeout: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (stall) return new Promise<Response>(() => {});
      const file = files[path.split('/').pop()!];
      return file === undefined ? new Response('missing', { status: 404 }) : new Response(file);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, asked, stop: () => server.stop(true) };
}

test('release archive names follow Bun releases, arm64 being aarch64', () => {
  expect(runtimeAsset('bun-linux-x64-baseline')).toBe('bun-linux-x64-baseline');
  expect(runtimeAsset('bun-darwin-x64')).toBe('bun-darwin-x64');
  expect(runtimeAsset('bun-darwin-arm64')).toBe('bun-darwin-aarch64');
  expect(() => runtimeAsset('bun-linux-x64-musl')).toThrow('no Bun release archive');
});

test('a release that never answers fails within the stall deadline, naming the file', async () => {
  const server = release({}, true);
  try {
    const started = performance.now();
    const failure = await bunRuntime(target, { version: '9.9.9', cacheRoot, releases: server.url, stallMs: 400 }).then(() => null, (error: Error) => error);
    expect(failure?.message).toBe(`could not download ${server.url}/bun-v9.9.9/SHASUMS256.txt: nothing arrived for 0.4 s`);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(readdirSync(cacheRoot)).toEqual([]);
  } finally {
    server.stop();
  }
});

test('a body that stops halfway fails within the stall deadline', async () => {
  const server = Bun.serve({
    port: 0, idleTimeout: 0,
    fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); } })),
  });
  try {
    const failure = await bunRuntime(target, { version: '9.9.9', cacheRoot, releases: `http://127.0.0.1:${server.port}`, stallMs: 400 }).then(() => null, (error: Error) => error);
    expect(failure?.message).toEndWith('SHASUMS256.txt: nothing arrived for 0.4 s');
  } finally {
    server.stop(true);
  }
});

test('the runtime is checked, kept per version and target, and read from the cache without the network after', async () => {
  const body = new TextEncoder().encode('#!/bin/sh\necho runtime\n');
  const zip = zipOf(`${asset}/${exe}`, body);
  const sum = new Bun.CryptoHasher('sha256').update(zip).digest('hex');
  const server = release({ 'SHASUMS256.txt': `${'0'.repeat(64)}  other.zip\n${sum}  ${asset}.zip\n`, [`${asset}.zip`]: zip });
  let path: string;
  try {
    path = await bunRuntime(target, { version: '9.9.9', cacheRoot, releases: server.url });
    expect(server.asked).toEqual(['/bun-v9.9.9/SHASUMS256.txt', `/bun-v9.9.9/${asset}.zip`]);
  } finally {
    server.stop();
  }
  expect(path).toBe(join(cacheRoot, `${target}-v9.9.9`, exe));
  expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho runtime\n');
  expect(readdirSync(cacheRoot)).toEqual([`${target}-v9.9.9`]);
  // The server is gone: the second call is the cache.
  expect(await bunRuntime(target, { version: '9.9.9', cacheRoot, releases: server.url, stallMs: 400 })).toBe(path);
});

test('an archive whose checksum differs is refused and nothing is cached', async () => {
  const zip = zipOf(`${asset}/${exe}`, new TextEncoder().encode('tampered'));
  const server = release({ 'SHASUMS256.txt': `${'a'.repeat(64)}  ${asset}.zip\n`, [`${asset}.zip`]: zip });
  try {
    await expect(bunRuntime(target, { version: '9.9.9', cacheRoot, releases: server.url })).rejects.toThrow(`SHASUMS256.txt says ${'a'.repeat(64)}`);
    expect(existsSync(join(cacheRoot, `${target}-v9.9.9`))).toBe(false);
  } finally {
    server.stop();
  }
});
