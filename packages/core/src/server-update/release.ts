import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { chmodSync, closeSync, createReadStream, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import shellConfig from '../../../../apps/shell/src-tauri/tauri.conf.json';

export const UPDATE_PUBLIC_KEY = shellConfig.plugins.updater.pubkey;
const REPOSITORY = 'https://github.com/mtsu-dev/boite';
/**
 * Where a release's files may live. The repository moved from beboite to
 * mtsu-dev on 2026-10-26: manifests published before the move name the old
 * owner, and GitHub redirects the old addresses.
 */
const OWNERS = [REPOSITORY, 'https://github.com/beboite/boite'];
const API = 'https://api.github.com/repos/mtsu-dev/boite/releases?per_page=100';
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024;
/** Compressed bytes inflated per step: each step holds the event loop for a few milliseconds. */
const UNPACK_CHUNK_BYTES = 64 * 1024;
/** Lets timers and sockets run: a read stream hands buffered chunks over without going round the event loop. */
const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));
const VERSION = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

export interface ServerOffer { version: string; publishedAt: string; url: string; signature: string }

async function json(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Update server answered HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new Error('Update metadata exceeds 4 MB');
  return JSON.parse(text);
}

/** The immutable release tag, with the same stable/nightly split as the desktop. */
export async function findServerOffer(current: string, arch: string, signal: AbortSignal): Promise<ServerOffer | null> {
  const releases = await json(API, signal);
  if (!Array.isArray(releases)) throw new Error('Update release list must be an array');
  const nightly = current.includes('-nightly.');
  const candidates = releases.filter(release => release && !release.draft && typeof release.tag_name === 'string'
    && release.tag_name.startsWith('v') && VERSION.test(release.tag_name.slice(1)) && release.tag_name.includes('-nightly.') === nightly);
  candidates.sort((a, b) => Bun.semver.order(b.tag_name.slice(1), a.tag_name.slice(1)));
  const release = candidates[0];
  if (!release || Bun.semver.order(release.tag_name.slice(1), current) <= 0) return null;
  const version: string = release.tag_name.slice(1);
  const manifest = await json(`${REPOSITORY}/releases/download/v${version}/latest.json`, signal) as {
    version?: unknown; platforms?: Record<string, { url?: unknown; signature?: unknown }>;
  };
  if (manifest.version !== version) throw new Error('Update manifest version does not match its release');
  const target = arch === 'x64' ? 'linux-x86_64-server' : arch === 'arm64' ? 'linux-aarch64-server' : '';
  const payload = manifest.platforms?.[target];
  if (!payload) return null; // Releases published before server bundles are never installation offers.
  const file = `boite-server_${version}_${arch}.zip`;
  const url = OWNERS.map(owner => `${owner}/releases/download/v${version}/${file}`).find(expected => payload.url === expected);
  if (!url || typeof payload.signature !== 'string' || payload.signature.length > 8192) {
    throw new Error(`Update payload must be the signed ${file} of this release`);
  }
  return { version, publishedAt: release.published_at, url, signature: payload.signature };
}

interface Minisign { prehashed: boolean; key: KeyObject; signed: Buffer; comment: string; global: Buffer }

/** Tauri's base64-encoded Minisign packet, including the trusted comment signature, checked against the publisher key. */
function readSignature(signature: string, publicKey: string): Minisign {
  const lines = Buffer.from(signature, 'base64').toString('utf8').trim().split('\n');
  const keyLines = Buffer.from(publicKey, 'base64').toString('utf8').trim().split('\n');
  const key = Buffer.from(keyLines[1] ?? '', 'base64');
  const packet = Buffer.from(lines[1] ?? '', 'base64');
  const comment = lines[2]?.replace(/^trusted comment: /, '');
  const global = Buffer.from(lines[3] ?? '', 'base64');
  if (key.length !== 42 || key.subarray(0, 2).toString() !== 'Ed' || packet.length !== 74
    || !key.subarray(2, 10).equals(packet.subarray(2, 10)) || lines.length !== 4
    || !lines[2]?.startsWith('trusted comment: ') || comment === undefined || global.length !== 64) {
    throw new Error('Update signature has an invalid Minisign packet or signing key');
  }
  const algorithm = packet.subarray(0, 2).toString();
  // Tauri also publishes legacy Ed packets; both formats authenticate the whole payload.
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error('Update signature algorithm must be Ed25519');
  const signingKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  return { prehashed: algorithm === 'ED', key: signingKey, signed: packet.subarray(10), comment, global };
}

/** `data` is the whole payload, or its BLAKE2b-512 digest for a prehashed packet. */
function checkSignature(minisign: Minisign, data: Uint8Array): void {
  const { key, signed, comment, global } = minisign;
  if (!verify(null, data, key, signed) || !verify(null, Buffer.concat([signed, Buffer.from(comment)]), key, global)) {
    throw new Error('Update signature verification failed; the installation was left unchanged');
  }
}

export function verifyPayload(bytes: Uint8Array, signature: string, publicKey = UPDATE_PUBLIC_KEY): void {
  const minisign = readSignature(signature, publicKey);
  checkSignature(minisign, minisign.prehashed ? createHash('blake2b512').update(bytes).digest() : bytes);
}

/**
 * Downloads the archive to `file` and verifies its signature over every byte
 * before it returns its SHA-256. A prehashed packet is checked against a digest
 * taken chunk by chunk as the bytes arrive, so the archive is never held in
 * memory; only a legacy packet, which signs the bytes themselves, reads it back.
 */
export async function downloadPayload(offer: ServerOffer, file: string, signal: AbortSignal, progress: (received: number, total: number | null) => void, publicKey = UPDATE_PUBLIC_KEY): Promise<string> {
  const minisign = readSignature(offer.signature, publicKey);
  const sha256 = createHash('sha256');
  const blake = minisign.prehashed ? createHash('blake2b512') : null;
  const stalled = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => stalled.abort(new Error('Update download received no data for 30 seconds')), 30_000); };
  let handle: number | undefined;
  arm();
  try {
    const response = await fetch(offer.url, { signal: AbortSignal.any([signal, stalled.signal]), headers: { 'accept-encoding': 'identity' } });
    if (!response.ok || !response.body) throw new Error(`Update download answered HTTP ${response.status}`);
    const length = response.headers.get('content-length');
    const total = length === null ? null : Number(length);
    if (total !== null && (!Number.isSafeInteger(total) || total < 1 || total > MAX_ARCHIVE_BYTES)) throw new Error('Update archive exceeds 160 MB');
    handle = openSync(file, 'wx', 0o600);
    let received = 0;
    let last = 0;
    for await (const chunk of response.body) {
      if (signal.aborted) throw signal.reason;
      arm();
      received += chunk.byteLength;
      if (received > MAX_ARCHIVE_BYTES) throw new Error('Update archive exceeds 160 MB');
      writeSync(handle, chunk);
      sha256.update(chunk);
      blake?.update(chunk);
      if (Date.now() - last >= 250) { progress(received, total); last = Date.now(); }
    }
    if (total !== null && received !== total) throw new Error('Update download ended before the complete archive arrived');
    progress(received, total ?? received);
  } finally {
    clearTimeout(timer!);
    if (handle !== undefined) closeSync(handle);
  }
  checkSignature(minisign, blake === null ? readFileSync(file) : blake.digest());
  return sha256.digest('hex');
}

const unsafePath = (name: string): boolean => name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..');

/**
 * Signed archives contain regular files only; no archive path is passed to an
 * external extractor. The archive is read and inflated a chunk at a time and
 * each entry is written as it inflates, so neither the archive nor its files are
 * held in memory and the event loop runs between chunks. Only the archive's own
 * names land here: a name outside the four allowed is refused before a byte of
 * it is written, and the version and required files are checked once all are.
 * A cancelled update stops at the next chunk.
 */
export async function unpackPayload(file: string, directory: string, version: string, signal?: AbortSignal): Promise<void> {
  const written = new Map<string, number>();
  const open = new Set<number>();
  let manifest: Buffer[] = [];
  let size = 0;
  const unzip = new Unzip(entry => {
    const name = entry.name;
    if (name !== 'boite-core' && name !== 'boite' && name !== 'server-release.json' && !name.startsWith('ui/')) throw new Error(`Unexpected server archive file: ${name}`);
    if (unsafePath(name)) throw new Error(`Unsafe server archive path: ${name}`);
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const handle = openSync(target, 'w', 0o600);
    open.add(handle);
    // A name listed twice keeps its last copy, as reading the whole archive at once did.
    written.set(name, 0);
    if (name === 'server-release.json') manifest = [];
    entry.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      if (size > MAX_UNPACKED_BYTES) throw new Error('Unpacked server archive exceeds 400 MB');
      writeSync(handle, data);
      written.set(name, written.get(name)! + data.length);
      if (name === 'server-release.json') manifest.push(Buffer.from(data));
      if (final) {
        open.delete(handle);
        closeSync(handle);
        chmodSync(target, name === 'boite' || name === 'boite-core' ? 0o755 : 0o644);
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  try {
    for await (const chunk of createReadStream(file, { highWaterMark: UNPACK_CHUNK_BYTES })) {
      unzip.push(chunk as Buffer);
      await nextTurn();
      signal?.throwIfAborted();
    }
    unzip.push(new Uint8Array(0), true);
  } finally {
    for (const handle of open) closeSync(handle);
  }
  if (open.size > 0) throw new Error('Signed server archive ended inside a file');
  const release = JSON.parse(Buffer.concat(manifest).toString('utf8') || 'null') as { version?: unknown } | null;
  if (release?.version !== version) throw new Error('Signed server archive version does not match the update offer');
  for (const required of ['boite-core', 'boite', 'ui/index.html']) if (!written.get(required)) throw new Error(`Signed archive is missing ${required}`);
}
