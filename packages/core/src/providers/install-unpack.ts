import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProviderInstall } from '@boite/contracts';
import { currentOs } from '../paths.ts';
import { refused } from '../errors.ts';

/** Compressed bytes handed to the unzip at once, and how long it may hold the thread before yielding. */
const EXTRACT_SLICE_BYTES = 16 * 1024;
const EXTRACT_YIELD_MS = 10;

/** A zip member may not climb out of the directory it is unpacked into. */
export function safeEntryPath(name: string): string | null {
  const cleaned = name.split('\\').join('/');
  if (cleaned.length === 0 || cleaned.endsWith('/')) return null;
  if (cleaned.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split('/').includes('..')) return null;
  return cleaned;
}

/**
 * fflate's streaming unzip, one archive chunk at a time, so a 400 MB member
 * never sits in memory. A member the descriptor does not list is skipped by
 * simply never being started. `signal` is the install run's own.
 */
export async function extractRelease(
  install: ProviderInstall,
  signal: AbortSignal,
  part: string,
  releaseDir: string,
): Promise<void> {
  const wanted = new Map(install.files.map((file) => [file.path.split('\\').join('/'), file]));
  mkdirSync(releaseDir, { recursive: true });
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

  // Loaded here, not at the top: evaluating fflate builds its Huffman tables,
  // about 8 ms that every core start would pay for an install it rarely runs.
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

    const target = join(releaseDir, safe);
    mkdirSync(dirname(target), { recursive: true });
    const handle = openSync(target, 'w');
    open.set(safe, handle);
    file.ondata = (error, chunk, final): void => {
      if (error !== null && error !== undefined) {
        failure ??= error;
        return;
      }
      if (chunk.byteLength > 0) writeSync(handle, chunk);
      if (final) {
        closeSync(handle);
        open.delete(safe);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    const stream = Bun.file(part).stream();
    const reader = stream.getReader();
    // Inflating runs on the core's own thread: a compressible member turns one
    // read into megabytes of output. Small slices, and a turn of the event loop
    // whenever a few milliseconds went by, keep RPCs and the cancel answering.
    let lastYield = performance.now();
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      for (let offset = 0; offset < value.byteLength; offset += EXTRACT_SLICE_BYTES) {
        unzip.push(value.subarray(offset, offset + EXTRACT_SLICE_BYTES), false);
        if (failure !== null) throw failure;
        if (performance.now() - lastYield >= EXTRACT_YIELD_MS) {
          await new Promise<void>((done) => setImmediate(done));
          lastYield = performance.now();
          if (signal.aborted) throw signal.reason;
        }
      }
    }
    unzip.push(new Uint8Array(0), true);
    if (failure !== null) throw failure;
  } finally {
    for (const handle of open.values()) closeSync(handle);
    open.clear();
  }
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
