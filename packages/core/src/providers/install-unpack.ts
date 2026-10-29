import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ProviderInstall } from '@boite/contracts';
import { currentOs } from '../paths.ts';
import { refused } from '../errors.ts';

/** Compressed bytes handed to the unzip at once, and how long it may hold the thread before yielding. */
const EXTRACT_SLICE_BYTES = 16 * 1024;
const EXTRACT_YIELD_MS = 10;

/**
 * True when any existing component between `root` and `target` is a symlink.
 * `root` itself is the caller's trusted directory and is not inspected. A
 * missing component stops the walk: nothing further down can have been planted.
 */
export function reachesThroughLink(root: string, target: string): boolean {
  const from = resolve(root);
  const rel = relative(from, resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let cursor = from;
  for (const part of rel.split(sep)) {
    if (part.length === 0) continue;
    cursor = join(cursor, part);
    try {
      if (lstatSync(cursor).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** An archive member may not climb out of the directory it is unpacked into. */
export function safeEntryPath(name: string): string | null {
  const cleaned = name.split('\\').join('/');
  if (cleaned.length === 0 || cleaned.endsWith('/')) return null;
  if (cleaned.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/**
 * fflate's streaming decompressors, one archive chunk at a time, so a 400 MB member
 * never sits in memory. A member the descriptor does not list is skipped by
 * simply never being started. `signal` is the install run's own.
 */
export async function extractRelease(
  install: ProviderInstall,
  signal: AbortSignal,
  part: string,
  releaseDir: string,
  root: string,
): Promise<void> {
  // `mkdir` follows a symlink ancestor such as `releases` or the provider
  // directory and would unpack outside `root`. The link itself is the refusal.
  if (reachesThroughLink(root, releaseDir)) throw refused('the release directory is a symlink');
  const wanted = new Map(install.files.map((file) => [file.path.split('\\').join('/'), file]));
  try {
    mkdirSync(releaseDir, { recursive: true });
  } catch (error) {
    // A symlink to an existing directory can make mkdir fail with EEXIST
    // after it has already followed the link. The lstat below still refuses it.
    if (!existsSync(releaseDir)) throw error;
  }
  // `mkdir` follows a symlink to a directory. A release name planted as a
  // link in the data directory would unpack outside the provider tree.
  if (lstatSync(releaseDir).isSymbolicLink()) throw refused('the release directory is a symlink');
  if (install.format === 'binary') {
    if (signal.aborted) throw signal.reason;
    const file = install.files[0];
    if (!file || install.files.length !== 1 || safeEntryPath(file.path) === null) {
      throw refused('a binary install requires exactly one safe relative file path');
    }
    const target = join(releaseDir, file.path.split('\\').join('/'));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(part, target);
    return;
  }

  const open = new Map<string, number>();
  let failure: Error | null = null;
  /** A listed member's file, opened without following a link planted in its place. */
  const openMember = (safe: string, entry: string): number => {
    const target = join(releaseDir, safe);
    if (reachesThroughLink(releaseDir, target)) {
      throw refused(`refusing to unpack ${safe} through a symlink`, { entry });
    }
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(dirname(target)).isSymbolicLink() || (existsSync(target) && lstatSync(target).isSymbolicLink())) {
      throw refused(`refusing to unpack ${safe} through a symlink`, { entry });
    }
    const handle = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    open.set(safe, handle);
    return handle;
  };
  const closeMember = (safe: string): void => {
    const handle = open.get(safe);
    if (handle === undefined) return;
    closeSync(handle);
    open.delete(safe);
  };

  try {
    // Loaded here, not at the top: evaluating fflate builds its Huffman tables,
    // about 8 ms that every core start would pay for an install it rarely runs.
    if (install.format === 'tgz') {
      const { Gunzip } = await import('fflate');
      const tar = new TarReader((name, type) => {
        // A directory is never written, and a link is never followed or made.
        if (type === TAR_DIRECTORY) return null;
        const safe = safeEntryPath(name);
        if (safe === null) {
          throw refused(`the archive holds an entry that escapes its directory: ${name}`, { entry: name });
        }
        if (!TAR_FILES.has(type) || !wanted.has(safe)) return null;
        const handle = openMember(safe, name);
        return { write: (chunk) => writeSync(handle, chunk), end: () => closeMember(safe) };
      });
      const gunzip = new Gunzip((chunk) => {
        if (failure !== null) return;
        try { tar.push(chunk); }
        catch (error) { failure = error instanceof Error ? error : refused(String(error)); }
      });
      await feedArchive(part, signal, (chunk, final) => gunzip.push(chunk, final), () => failure);
      if (failure !== null) throw failure;
      tar.finish();
      return;
    }

    const { Unzip, UnzipInflate } = await import('fflate');
    const unzip = new Unzip((file) => {
      if (failure !== null) return;
      const safe = safeEntryPath(file.name);
      if (safe === null) {
        if (file.name.endsWith('/') || file.name.endsWith('\\')) return;
        failure = refused(`the archive holds an entry that escapes its directory: ${file.name}`, {
          entry: file.name,
        });
        return;
      }
      if (!wanted.has(safe)) return;

      let handle: number;
      try {
        handle = openMember(safe, file.name);
      } catch (error) {
        failure = error instanceof Error ? error : refused(String(error), { entry: file.name });
        return;
      }
      file.ondata = (error, chunk, final): void => {
        if (error !== null && error !== undefined) {
          failure ??= error;
          return;
        }
        if (chunk.byteLength > 0) writeSync(handle, chunk);
        if (final) closeMember(safe);
      };
      file.start();
    });
    unzip.register(UnzipInflate);
    await feedArchive(part, signal, (chunk, final) => unzip.push(chunk, final), () => failure);
    if (failure !== null) throw failure;
  } finally {
    for (const handle of open.values()) closeSync(handle);
    open.clear();
  }
}

/**
 * Streams the downloaded archive into a decompressor. Inflating runs on the
 * core's own thread: a compressible member turns one read into megabytes of
 * output. Small slices, and a turn of the event loop whenever a few
 * milliseconds went by, keep RPCs and the cancel answering.
 */
async function feedArchive(
  part: string,
  signal: AbortSignal,
  push: (chunk: Uint8Array, final: boolean) => void,
  failure: () => Error | null,
): Promise<void> {
  const reader = Bun.file(part).stream().getReader();
  let lastYield = performance.now();
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += EXTRACT_SLICE_BYTES) {
        push(value.subarray(offset, offset + EXTRACT_SLICE_BYTES), false);
        const failed = failure();
        if (failed !== null) throw failed;
        if (performance.now() - lastYield >= EXTRACT_YIELD_MS) {
          await new Promise<void>((done) => setImmediate(done));
          lastYield = performance.now();
          if (signal.aborted) throw signal.reason;
        }
      }
    }
    push(new Uint8Array(0), true);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

const TAR_BLOCK = 512;
/** Only names and pax records are buffered; file bodies always stream to disk. */
const TAR_METADATA_BYTES = 1024 * 1024;
/** Regular files: `0`, the old NUL, and `7` (contiguous). */
const TAR_FILES = new Set([0x30, 0x00, 0x37]);
const TAR_DIRECTORY = 0x35;
/** A pax header can name the next entry's path, and a GNU `L` entry does the same. */
const TAR_PAX = 0x78;
const TAR_PAX_GLOBAL = 0x67;
const TAR_GNU_LONG_NAME = 0x4c;

export type TarSink = { write: (chunk: Uint8Array) => void; end: () => void };

/**
 * A ustar reader fed the gunzipped stream a piece at a time, so no member is
 * held whole. `onEntry` returns where a member's bytes go, or null to skip
 * it; pax and GNU long names apply to the entry they precede.
 */
export class TarReader {
  readonly #onEntry: (name: string, type: number) => TarSink | null;
  readonly #header = new Uint8Array(TAR_BLOCK);
  #headerFill = 0;
  #remaining = 0;
  #padding = 0;
  #sink: TarSink | null = null;
  #meta: { type: number; chunks: Uint8Array[] } | null = null;
  #nextName: string | null = null;
  #ended = false;

  constructor(onEntry: (name: string, type: number) => TarSink | null) {
    this.#onEntry = onEntry;
  }

  push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength && !this.#ended) {
      if (this.#remaining > 0) {
        const take = Math.min(this.#remaining, chunk.byteLength - offset);
        const piece = chunk.subarray(offset, offset + take);
        if (this.#meta !== null) this.#meta.chunks.push(piece.slice());
        else this.#sink?.write(piece);
        this.#remaining -= take;
        offset += take;
        if (this.#remaining === 0) this.#endEntry();
        continue;
      }
      if (this.#padding > 0) {
        const skip = Math.min(this.#padding, chunk.byteLength - offset);
        this.#padding -= skip;
        offset += skip;
        continue;
      }
      const take = Math.min(TAR_BLOCK - this.#headerFill, chunk.byteLength - offset);
      this.#header.set(chunk.subarray(offset, offset + take), this.#headerFill);
      this.#headerFill += take;
      offset += take;
      if (this.#headerFill === TAR_BLOCK) {
        this.#headerFill = 0;
        this.#startEntry();
      }
    }
  }

  /** The stream is over: a member cut short means the archive was. */
  finish(): void {
    if (this.#remaining > 0 || this.#headerFill > 0 || this.#padding > 0) throw refused('the archive ends in the middle of an entry');
  }

  #startEntry(): void {
    const header = this.#header;
    if (header.every((byte) => byte === 0)) {
      this.#ended = true;
      return;
    }
    // The checksum counts its own eight bytes as spaces.
    let sum = 0;
    for (let index = 0; index < TAR_BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
    if (sum !== tarNumber(header.subarray(148, 156))) {
      throw refused('the archive is not a tar archive: a header checksum does not match');
    }
    const size = tarNumber(header.subarray(124, 136));
    const type = header[156]!;
    const prefix = tarString(header.subarray(257, 262)) === 'ustar' ? tarString(header.subarray(345, 500)) : '';
    const plain = tarString(header.subarray(0, 100));
    this.#remaining = size;
    this.#padding = (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK;
    if (type === TAR_PAX || type === TAR_GNU_LONG_NAME || type === TAR_PAX_GLOBAL) {
      if (size > TAR_METADATA_BYTES) throw refused('the archive name metadata exceeds 1 MiB');
      this.#meta = { type, chunks: [] };
    } else {
      const name = this.#nextName ?? (prefix === '' ? plain : `${prefix}/${plain}`);
      this.#nextName = null;
      this.#sink = this.#onEntry(name, type);
    }
    if (size === 0) this.#endEntry();
  }

  #endEntry(): void {
    const meta = this.#meta;
    this.#meta = null;
    if (meta === null) {
      this.#sink?.end();
      this.#sink = null;
      return;
    }
    const text = new TextDecoder().decode(Buffer.concat(meta.chunks));
    if (meta.type === TAR_GNU_LONG_NAME) this.#nextName = text.replace(/\0+$/, '');
    if (meta.type === TAR_PAX) {
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(text)?.[1];
      if (path !== undefined) this.#nextName = path;
    }
  }
}

function tarString(field: Uint8Array): string {
  const end = field.indexOf(0);
  return new TextDecoder().decode(end === -1 ? field : field.subarray(0, end));
}

/** Octal, or base-256 when the first byte has its high bit set. */
function tarNumber(field: Uint8Array): number {
  let value: number;
  if ((field[0]! & 0x80) !== 0) {
    value = field[0]! & 0x7f;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
  } else {
    const text = tarString(field).trim();
    if (!/^[0-7]*$/.test(text)) throw refused('the archive holds an invalid tar number');
    value = text === '' ? 0 : Number.parseInt(text, 8);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw refused('the archive holds an invalid tar number');
  return value;
}

export function checkSizes(install: ProviderInstall, releaseDir: string): void {
  for (const file of install.files) {
    const target = join(releaseDir, file.path.split('\\').join('/'));
    if (!existsSync(target)) {
      throw refused(`the archive does not hold ${file.path}`, { file: file.path });
    }
    const actual = lstatSync(target).size;
    if (actual !== file.bytes) {
      throw refused(`${file.path} unpacked to ${actual} bytes, the descriptor expected ${file.bytes}`, {
        file: file.path,
        expectedBytes: file.bytes,
        actualBytes: actual,
      });
    }
  }
}

/** Off Windows a zip carries no mode Boite trusts, so the executable is made one. */
export function markExecutable(install: ProviderInstall, releaseDir: string): void {
  if (currentOs() === 'windows') return;
  for (const [index, file] of install.files.entries()) {
    if (index === 0 || file.executable === true) {
      chmodSync(join(releaseDir, file.path.split('\\').join('/')), 0o755);
    }
  }
}
