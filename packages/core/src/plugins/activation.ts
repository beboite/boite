import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';

/** What an activation in progress wrote first: which binary goes and which comes. */
export const ACTIVATION_FILE = 'activation.json';
/** The record of the release being activated; renaming it to `installed.json` is the commit. */
const STAGED_RECORD = 'installed.json.part';
const RECORD = 'installed.json';
/**
 * Beside a binary an activation replaces, tagged with that activation: a
 * backup a lock kept after its commit is never taken for the next one's.
 */
const KEPT = /\.previous-[0-9a-f]{12}$/;

interface Intent {
  /** The binary the plugin ran before, by file name in its directory; null for a first install. */
  previous: string | null;
  /** The binary the new release runs. */
  binary: string;
  /** Where this activation moves `previous` until its record commits; null for a first install. */
  kept: string | null;
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

/**
 * Backups of activations that committed: nothing restores them any more.
 * Removing them is retried on every read while a running process locks them.
 */
function sweep(dir: string, keep: string | null): void {
  for (const name of readdirSync(dir)) if (KEPT.test(name) && name !== keep) bestEffort(join(dir, name));
}

/**
 * Restores what this activation moved, and only that. The previous binary
 * comes back before the new one goes, so a lock leaves one of them in place,
 * and the intent stays for a later read to finish the job.
 */
function rollback(dir: string, intent: Intent): void {
  const kept = intent.kept === null ? null : join(dir, intent.kept);
  if (kept !== null && existsSync(kept)) {
    renameSync(kept, join(dir, intent.previous!));
    if (intent.binary !== intent.previous) rmSync(join(dir, intent.binary), { force: true });
  } else if (intent.binary !== intent.previous) {
    // The previous binary never moved, or there was none: only a new name to drop.
    rmSync(join(dir, intent.binary), { force: true });
  }
  rmSync(join(dir, STAGED_RECORD), { recursive: true, force: true });
  rmSync(join(dir, ACTIVATION_FILE), { force: true });
}

/**
 * After the commit: the release is installed whatever this manages to remove,
 * so it never throws. A backup still locked is swept on a later read.
 */
function finish(dir: string): void {
  bestEffort(join(dir, ACTIVATION_FILE));
  sweep(dir, null);
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
  // An activation left unsettled goes back to its record first; one that still cannot is never started over.
  if (existsSync(join(dir, ACTIVATION_FILE))) recoverActivation(dir);
  if (existsSync(join(dir, ACTIVATION_FILE))) throw new Error(`${dir} holds an update that did not finish and could not be rolled back yet`);
  const previous = release.previous === null ? null : basename(release.previous);
  const intent: Intent = { previous, binary: basename(release.binary), kept: previous === null ? null : `${previous}.previous-${randomBytes(6).toString('hex')}` };
  flush(release.temporary);
  writeDurable(join(dir, STAGED_RECORD), release.record);
  writeDurable(join(dir, ACTIVATION_FILE), JSON.stringify(intent));
  flushEntries(dir);
  try {
    if (intent.previous !== null) renameSync(join(dir, intent.previous), join(dir, intent.kept!));
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
      finish(dir);
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

function parseIntent(text: string): Intent | null {
  try {
    const raw = JSON.parse(text) as Partial<Intent>;
    if (!plainName(raw.binary)) return null;
    if (raw.previous === null && raw.kept === null) return { previous: null, binary: raw.binary, kept: null };
    if (plainName(raw.previous) && plainName(raw.kept) && raw.kept.startsWith(`${raw.previous}.`) && KEPT.test(raw.kept)) return { previous: raw.previous, binary: raw.binary, kept: raw.kept };
  } catch { /* cut off while it was written */ }
  return null;
}

/**
 * Settles an activation a stopped core left behind: one whose record never
 * committed goes back to the previous release, one that committed drops what
 * it kept. An intent that does not parse was cut off before anything moved,
 * and a staged record with no intent was cut off before its intent was
 * written. Backups of committed activations go too. Returns what it did, or
 * null when there was no activation to settle.
 */
export function recoverActivation(dir: string): 'restored' | 'finished' | null {
  const file = join(dir, ACTIVATION_FILE);
  if (!existsSync(file)) {
    rmSync(join(dir, STAGED_RECORD), { recursive: true, force: true });
    if (existsSync(dir)) sweep(dir, null);
    return null;
  }
  const intent = parseIntent(readFileSync(file, 'utf8'));
  if (intent === null) {
    rmSync(join(dir, STAGED_RECORD), { recursive: true, force: true });
    rmSync(file, { force: true });
    sweep(dir, null);
    return 'restored';
  }
  if (existsSync(join(dir, STAGED_RECORD))) {
    sweep(dir, intent.kept);
    rollback(dir, intent);
    return 'restored';
  }
  finish(dir);
  return 'finished';
}
