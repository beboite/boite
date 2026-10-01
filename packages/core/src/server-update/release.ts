import { createHash, createPublicKey, verify } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unzipSync } from 'fflate';
import shellConfig from '../../../../apps/shell/src-tauri/tauri.conf.json';

export const UPDATE_PUBLIC_KEY = shellConfig.plugins.updater.pubkey;
const REPOSITORY = 'https://github.com/beboite/boite';
const API = 'https://api.github.com/repos/beboite/boite/releases?per_page=100';
const MAX_ARCHIVE_BYTES = 160 * 1024 * 1024;
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
  const expected = `${REPOSITORY}/releases/download/v${version}/${file}`;
  if (payload.url !== expected || typeof payload.signature !== 'string' || payload.signature.length > 8192) {
    throw new Error(`Update payload must be the signed ${file} of this release`);
  }
  return { version, publishedAt: release.published_at, url: expected, signature: payload.signature };
}

/** Tauri's base64-encoded Minisign packet, including the trusted comment signature. */
export function verifyPayload(bytes: Uint8Array, signature: string, publicKey = UPDATE_PUBLIC_KEY): void {
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
  const data = algorithm === 'ED' ? createHash('blake2b512').update(bytes).digest() : bytes;
  const signingKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  const signed = packet.subarray(10);
  if (!verify(null, data, signingKey, signed) || !verify(null, Buffer.concat([signed, Buffer.from(comment)]), signingKey, global)) {
    throw new Error('Update signature verification failed; the installation was left unchanged');
  }
}

export async function downloadPayload(offer: ServerOffer, file: string, signal: AbortSignal, progress: (received: number, total: number | null) => void): Promise<string> {
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
      if (Date.now() - last >= 250) { progress(received, total); last = Date.now(); }
    }
    if (total !== null && received !== total) throw new Error('Update download ended before the complete archive arrived');
    progress(received, total ?? received);
  } finally {
    clearTimeout(timer!);
    if (handle !== undefined) closeSync(handle);
  }
  const bytes = readFileSync(file);
  verifyPayload(bytes, offer.signature);
  return createHash('sha256').update(bytes).digest('hex');
}

/** Signed archives contain regular files only; no archive path is passed to an external extractor. */
export function unpackPayload(file: string, directory: string, version: string): void {
  const entries = unzipSync(readFileSync(file));
  const manifest = JSON.parse(Buffer.from(entries['server-release.json'] ?? []).toString('utf8')) as { version?: unknown };
  if (manifest.version !== version) throw new Error('Signed server archive version does not match the update offer');
  for (const required of ['boite-core', 'boite', 'ui/index.html']) if (!entries[required]?.length) throw new Error(`Signed archive is missing ${required}`);
  let size = 0;
  for (const [name, bytes] of Object.entries(entries)) {
    if (name !== 'boite-core' && name !== 'boite' && name !== 'server-release.json' && !name.startsWith('ui/')) throw new Error(`Unexpected server archive file: ${name}`);
    if (name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe server archive path: ${name}`);
    size += bytes.length;
    if (size > 400 * 1024 * 1024) throw new Error('Unpacked server archive exceeds 400 MB');
    const target = join(directory, name);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { mode: 0o600 });
    chmodSync(target, name === 'boite' || name === 'boite-core' ? 0o755 : 0o644);
  }
}
