import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * How checkpoint blobs and manifests sit on disk. A blob keeps the SHA-256 of
 * the original bytes as its name; its content is a zstd frame when that saves
 * at least a tenth, the raw bytes otherwise. Readers look for the zstd magic,
 * so blobs and manifests written before compression read unchanged.
 */

const ZSTD_LEVEL = 3;
/** A compressed blob is kept only when it is at most this share of the original. */
const KEEP_RATIO = 0.9;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const framed = (bytes: Uint8Array) => bytes.length >= 4 && MAGIC.equals(bytes.subarray(0, 4));
export const isBlobName = (name: string) => /^[0-9a-f]{64}$/.test(name);

/**
 * The stored form of `bytes`. Raw bytes that already start with the magic (a
 * `.zst` file in a project) are always framed, so no reader takes them for a frame.
 */
export async function encodeBlob(bytes: Buffer): Promise<Buffer> {
  if (bytes.length < 64 && !framed(bytes)) return bytes;
  const compressed = Buffer.from(await Bun.zstdCompress(bytes, { level: ZSTD_LEVEL }));
  return compressed.length <= bytes.length * KEEP_RATIO || framed(bytes) ? compressed : bytes;
}

/**
 * The original bytes of a stored blob, or null when they do not hash to
 * `hash`. A blob written before compression that happens to start with the
 * magic is still found by its raw hash.
 */
export async function decodeBlob(stored: Buffer, hash: string): Promise<Buffer | null> {
  if (framed(stored)) {
    const content = await Bun.zstdDecompress(stored).then(bytes => Buffer.from(bytes), () => null);
    if (content && sha256(content) === hash) return content;
  }
  return sha256(stored) === hash ? stored : null;
}

/** The original bytes of the blob at `path`, or null when it is missing or does not match its name. */
export async function readBlob(path: string, hash: string): Promise<Buffer | null> {
  const stored = await readFile(path).catch(() => null);
  return stored === null ? null : decodeBlob(stored, hash);
}

/** A manifest as written: always a zstd frame, the JSON inside. */
export async function encodeManifest(value: unknown): Promise<Buffer> {
  return Buffer.from(await Bun.zstdCompress(Buffer.from(JSON.stringify(value)), { level: ZSTD_LEVEL }));
}

/** A manifest written either way: a zstd frame, or the plain JSON of older cores. */
export async function decodeManifest<T>(stored: Buffer): Promise<T> {
  const text = framed(stored) ? Buffer.from(await Bun.zstdDecompress(stored)).toString('utf8') : stored.toString('utf8');
  return JSON.parse(text) as T;
}

/** `<shared>/<first two hex digits>/<hash>`, so no folder holds every blob. */
export function sharedBlob(shared: string, hash: string): string { return join(shared, hash.slice(0, 2), hash); }

export const NO_LINK = new Set(['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EMLINK', 'EINVAL']);
export const errno = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';
const inode = (info: { dev: number | bigint; ino: number | bigint }) => `${info.dev}:${info.ino}`;

/** Whether `path` starts with the magic, reading four bytes. */
async function framedFile(path: string): Promise<boolean> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(4);
    const { bytesRead } = await handle.read(head, 0, 4, 0);
    return bytesRead === 4 && framed(head);
  } finally { await handle.close(); }
}

/** Replace `dest` by a hard link to `source` in one rename. False when the file system has no hard links. */
async function linkOver(source: string, dest: string): Promise<boolean> {
  const temporary = `${dest}.tmp-${randomUUID()}`;
  try { await link(source, temporary); }
  catch (error) { if (NO_LINK.has(errno(error))) return false; throw error; }
  try { await rename(temporary, dest); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return true;
}

export interface StoreCounts {
  /** Names now linked to the shared blob, replacing a copy of their own. */
  linked: number;
  /** Copies moved into the shared store because it had none. */
  adopted: number;
  /** Shared blobs rewritten as a zstd frame. */
  compressed: number;
  /** Manifests rewritten as a zstd frame. */
  manifests: number;
  /** Files whose content does not hash to their name; left as they are. */
  mismatched: number;
  /** Copies kept because the file system refused a hard link. */
  unlinked: number;
  /** Bytes read, for the caller's budget. */
  bytesRead: number;
}

export const emptyCounts = (): StoreCounts => ({ linked: 0, adopted: 0, compressed: 0, manifests: 0, mismatched: 0, unlinked: 0, bytesRead: 0 });

/**
 * Walks blobs written before the shared store, or before compression, into
 * the shared form: each name in a thread's `objects` becomes a hard link to
 * `<shared>/xx/<hash>`, and that blob a zstd frame where it pays. `settled`
 * holds shared inodes already checked in this pass, so a blob linked from a
 * hundred folders is read once.
 */
export class StoreMigration {
  readonly counts = emptyCounts();
  readonly settled = new Set<string>();
  private readonly folders = new Set<string>();

  constructor(private readonly shared: string) {}

  /**
   * One name of a thread folder. Only the shared blob is checked before a
   * private copy is replaced by a link to it; a copy moved into the store is
   * checked first, since its bytes become the store's.
   */
  async blob(objects: string, name: string): Promise<void> {
    if (!isBlobName(name)) return;
    const path = join(objects, name);
    const own = await lstat(path, { bigint: true }).catch(() => null);
    if (!own?.isFile()) return;
    const source = sharedBlob(this.shared, name);
    let shared = await this.settle(source, name);
    if (shared && shared === inode(own)) return;
    if (shared) {
      if (await linkOver(source, path)) this.counts.linked += 1;
      else this.counts.unlinked += 1;
      return;
    }
    const stored = await readFile(path);
    this.counts.bytesRead += stored.length;
    const content = await decodeBlob(stored, name);
    if (!content) { this.counts.mismatched += 1; return; }
    const encoded = framed(stored) ? stored : await encodeBlob(content);
    const folder = join(this.shared, name.slice(0, 2));
    if (!this.folders.has(folder)) { await mkdir(folder, { recursive: true, mode: 0o700 }); this.folders.add(folder); }
    await rm(source, { force: true });
    if (encoded === stored) {
      try { await link(path, source); }
      catch (error) { if (NO_LINK.has(errno(error))) { this.counts.unlinked += 1; return; } throw error; }
    } else {
      // The frame is complete under a temporary name before the store names it.
      const temporary = `${path}.tmp-${randomUUID()}`;
      try {
        await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
        try { await link(temporary, source); }
        catch (error) { if (NO_LINK.has(errno(error))) { this.counts.unlinked += 1; return; } throw error; }
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
    }
    shared = inode(await lstat(source, { bigint: true }));
    this.settled.add(shared);
    this.counts.adopted += 1;
  }

  /**
   * The inode of a sound shared blob for `hash`, compressed when that pays,
   * or null when there is none: a missing blob, or one that does not hash to
   * its name, which is removed so a sound copy can take its place.
   */
  private async settle(source: string, hash: string): Promise<string | null> {
    const info = await lstat(source, { bigint: true }).catch(() => null);
    if (!info?.isFile()) return null;
    const key = inode(info);
    if (this.settled.has(key)) return key;
    if (info.size >= 4n && await framedFile(source)) {
      // A frame is checked whole once: a crash can leave one short.
      const stored = await readFile(source);
      this.counts.bytesRead += stored.length;
      if (!await decodeBlob(stored, hash)) { this.counts.mismatched += 1; await rm(source, { force: true }); return null; }
      this.settled.add(key);
      return key;
    }
    const raw = await readFile(source);
    this.counts.bytesRead += raw.length;
    if (sha256(raw) !== hash) { this.counts.mismatched += 1; await rm(source, { force: true }); return null; }
    const encoded = await encodeBlob(raw);
    if (encoded === raw) { this.settled.add(key); return key; }
    // Names elsewhere keep the raw inode until their folder is walked.
    const temporary = `${source}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      await rename(temporary, source);
    } finally { await rm(temporary, { force: true }); }
    this.counts.compressed += 1;
    const next = inode(await lstat(source, { bigint: true }));
    this.settled.add(next);
    return next;
  }

  /** A manifest in plain JSON becomes a zstd frame; anything unreadable stays. */
  async manifest(path: string): Promise<void> {
    const stored = await readFile(path).catch(() => null);
    if (!stored || framed(stored)) return;
    this.counts.bytesRead += stored.length;
    let value: unknown;
    try { value = JSON.parse(stored.toString('utf8')); } catch { return; }
    const temporary = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, await encodeManifest(value), { mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    this.counts.manifests += 1;
  }
}

/** The blob hashes a manifest needs to rewind. */
export function neededBlobs(checkpoint: { before?: Record<string, { hash: string; link?: string; unbacked?: true }>; after?: Record<string, { hash: string; link?: string; unbacked?: true }> }): string[] {
  const hashes: string[] = [];
  for (const side of [checkpoint.before, checkpoint.after]) {
    for (const entry of Object.values(side ?? {})) if (entry.link === undefined && !entry.unbacked) hashes.push(entry.hash);
  }
  return hashes;
}

/**
 * Keeps `keep` manifests of a thread folder, removes the others and every
 * blob of its `objects` none of the kept ones names. A manifest that cannot
 * be read keeps every blob. Returns the counts removed.
 */
export async function trimFolder(folder: string, keep: Set<string>): Promise<{ manifests: number; blobs: number }> {
  const removed = { manifests: 0, blobs: 0 };
  const needed = new Set<string>();
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue;
    const turnId = name.slice(0, -'.json'.length);
    if (!keep.has(turnId)) { await rm(join(folder, name), { force: true }); removed.manifests += 1; continue; }
    try { for (const hash of neededBlobs(await decodeManifest(await readFile(join(folder, name))))) needed.add(hash); }
    catch { return removed; }
  }
  const objects = join(folder, 'objects');
  for (const name of await readdir(objects).catch(() => [] as string[])) {
    if (!isBlobName(name) || needed.has(name)) continue;
    await rm(join(objects, name), { force: true });
    removed.blobs += 1;
  }
  return removed;
}
