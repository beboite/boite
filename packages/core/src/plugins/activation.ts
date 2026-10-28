import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

/** What an activation in progress wrote first: which binary goes and which comes. */
export const ACTIVATION_FILE = 'activation.json';
/** The record of the release being activated; renaming it to `installed.json` is the commit. */
const STAGED_RECORD = 'installed.json.part';
const RECORD = 'installed.json';
/** Beside a binary an activation replaces, until the record commits. */
const KEPT = '.previous';

interface Intent {
  /** The binary the plugin ran before, by file name in its directory; null for a first install. */
  previous: string | null;
  /** The binary the new release runs. */
  binary: string;
}

export interface Activation {
  /** Writes the record that names the new release, then drops the previous binary. Only then is the release installed. */
  commit(): void;
  /** Puts the previous binary and record back, as if the activation never started. */
  rollback(): void;
}

/** Written and flushed before anything it describes happens, so a restart reads it whole or reads nothing it acted on. */
function writeDurable(path: string, text: string): void {
  const fd = openSync(path, 'w', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Flushes a file, or with `r` a directory, so a rename cannot persist before what it names does. */
function flush(path: string, mode: 'r' | 'r+' = 'r+'): void {
  const fd = openSync(path, mode);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Flushes the directory's entries: a rename is atomic, not durable, until
 * then. Windows cannot open a directory for this, and NTFS journals the
 * rename itself.
 */
function flushEntries(dir: string): void {
  if (process.platform === 'win32') return;
  flush(dir, 'r');
}

/** Removes what a finished activation no longer needs; false when the file is still locked. */
function bestEffort(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

function rollback(dir: string, intent: Intent): void {
  const kept = intent.previous === null ? null : join(dir, intent.previous + KEPT);
  const moved = kept !== null && existsSync(kept);
  // The new binary goes, unless it has the previous one's name and that one never moved aside.
  if (intent.previous !== intent.binary || moved) rmSync(join(dir, intent.binary), { force: true });
  if (moved) renameSync(kept, join(dir, intent.previous!));
  rmSync(join(dir, STAGED_RECORD), { recursive: true, force: true });
  rmSync(join(dir, ACTIVATION_FILE), { force: true });
}

/**
 * After the commit: the release is installed whatever this manages to remove,
 * so it never throws. The intent stays while the previous binary does, for
 * `recoverActivation` to try again on a later read.
 */
function finish(dir: string, intent: Intent): void {
  if (intent.previous !== null && !bestEffort(join(dir, intent.previous + KEPT))) return;
  bestEffort(join(dir, ACTIVATION_FILE));
}

/**
 * Swaps a staged binary into a plugin's directory as one step with its
 * record. The record and the intent are written first; the previous binary
 * moves aside as `<name>.previous`, the new one takes its place, and only the
 * rename of the record commits. Until then `rollback` (or, after a crash,
 * `recoverActivation`) restores the binary and the record that worked
 * together. Synchronous, so nothing else of this core runs in between.
 */
export function switchRelease(dir: string, release: { previous: string | null; binary: string; temporary: string; record: string }): Activation {
  const intent: Intent = { previous: release.previous === null ? null : basename(release.previous), binary: basename(release.binary) };
  flush(release.temporary);
  writeDurable(join(dir, STAGED_RECORD), release.record);
  writeDurable(join(dir, ACTIVATION_FILE), JSON.stringify(intent));
  flushEntries(dir);
  try {
    if (intent.previous !== null) {
      rmSync(join(dir, intent.previous + KEPT), { force: true });
      renameSync(join(dir, intent.previous), join(dir, intent.previous + KEPT));
    }
    renameSync(release.temporary, join(dir, intent.binary));
    flushEntries(dir);
  } catch (error) {
    rollback(dir, intent);
    throw error;
  }
  let settled = false;
  return {
    commit: () => {
      if (settled) return;
      renameSync(join(dir, STAGED_RECORD), join(dir, RECORD));
      settled = true;
      // Committed: what follows cannot undo it, so it cannot fail it either.
      try { flushEntries(dir); } catch { /* the rename stands; only its durability is unconfirmed */ }
      finish(dir, intent);
    },
    rollback: () => {
      if (settled) return;
      settled = true;
      rollback(dir, intent);
    },
  };
}

function plainName(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && basename(value) === value && value !== '.' && value !== '..';
}

/**
 * Settles an activation a stopped core left behind: one whose record never
 * committed goes back to the previous release, one that committed drops what
 * it kept. An intent that does not parse was cut off before anything moved.
 * Returns what it did, or null when there was nothing to settle.
 */
export function recoverActivation(dir: string): 'restored' | 'finished' | null {
  const file = join(dir, ACTIVATION_FILE);
  if (!existsSync(file)) return null;
  let intent: Intent | null = null;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Intent>;
    if ((raw.previous === null || plainName(raw.previous)) && plainName(raw.binary)) intent = { previous: raw.previous, binary: raw.binary };
  } catch { /* cut off while it was written */ }
  if (intent === null) {
    rmSync(join(dir, STAGED_RECORD), { recursive: true, force: true });
    rmSync(file, { force: true });
    return 'restored';
  }
  if (existsSync(join(dir, STAGED_RECORD))) {
    rollback(dir, intent);
    return 'restored';
  }
  finish(dir, intent);
  return 'finished';
}
