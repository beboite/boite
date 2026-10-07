/**
 * The version each program file reports, for the executable candidates that
 * only count at one major (`ExecutableCandidate.major`).
 *
 * Asking a program its version starts it, which resolving a candidate cannot
 * wait for: resolution is synchronous and runs for every provider list. So a
 * reading is kept per program path, with the size and the modification time of
 * the file it leads to. A candidate whose program has no reading yet does not
 * resolve; the read starts in the background and, once it is in, every
 * attached core hears `changed` and lists its providers again. The readings
 * are written beside the core's data, so a restart resolves at once.
 *
 * A program replaced in place changes its file and is asked again by itself.
 * A launcher script that stays the same while the program behind it changes
 * does not, so every reading taken from the file is also checked once per run
 * of the core, at the first resolution that comes half a minute or more after
 * its first use, and again after an agent update (`recheckVersions`). Nothing
 * here runs on a timer: a program is only ever started by a resolution that
 * asks, which a provider turned off never does.
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
/** A program that could not be asked is asked again after this long, not at every resolution. */
const RETRY_MS = 60_000;
/** How long after its first use a kept reading is due for a check against the program, so nothing extra runs while the core starts. */
const RECHECK_AFTER_MS = 30_000;

/** The first `x.y.z` in what a program printed, null when there is none. */
export function readVersion(output: string): string | null {
  return VERSION_PATTERN.exec(output)?.[0] ?? null;
}

interface Reading {
  mtimeMs: number;
  size: number;
  version: string | null;
}

/** What a core lends this module: a way to run a program, a place to keep the readings, and its ear. */
export interface VersionHost {
  /** Where the readings are kept between two runs of the core. */
  file: string;
  /** Everything the program printed for these arguments. Rejects when it could not run. */
  run(program: string, args: string[]): Promise<string>;
  /** A reading that was missing is in: what a candidate resolves to may have changed. */
  changed(): void;
}

const readings = new Map<string, Reading>();
const pending = new Map<string, Promise<void>>();
/** Programs asked for before any core could run them, with the arguments to ask them with. */
const waiting = new Map<string, string[]>();
/** Programs that could not be run, with when and the file they were then: a file that changed since is asked at once. */
const failures = new Map<string, { at: number; mtimeMs: number; size: number }>();
const hosts = new Set<VersionHost>();
/** Paths whose reading this run already took from the program itself, or is about to. */
const fresh = new Set<string>();
/** From when a reading kept from an earlier run is due for its check against the program. */
const due = new Map<string, number>();

function isReading(value: unknown): value is Reading {
  if (typeof value !== 'object' || value === null) return false;
  const reading = value as Partial<Reading>;
  return typeof reading.mtimeMs === 'number' && typeof reading.size === 'number'
    && (reading.version === null || typeof reading.version === 'string');
}

/** The readings a previous run kept. A file that is missing or unreadable keeps nothing: each program is asked again. */
export function loadVersions(file: string): void {
  let stored: unknown;
  try { stored = JSON.parse(readFileSync(file, 'utf8')); } catch { return; }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return;
  for (const [path, reading] of Object.entries(stored)) {
    if (!readings.has(path) && isReading(reading)) readings.set(path, reading);
  }
}

function persist(): void {
  const body = `${JSON.stringify(Object.fromEntries(readings), null, 2)}\n`;
  for (const host of hosts) {
    try {
      mkdirSync(dirname(host.file), { recursive: true });
      writeFileSync(host.file, body);
    } catch {
      // The readings stay in memory: the next run asks the programs again.
    }
  }
}

function start(program: string, args: string[]): void {
  if (pending.has(program)) return;
  const host = [...hosts].at(-1);
  if (host === undefined) {
    waiting.set(program, args);
    return;
  }
  let stat: { mtimeMs: number; size: number };
  try { stat = statSync(program); } catch { return; }
  fresh.add(program);
  // What a resolution answers while this read runs: the kept reading when it
  // still fits the file (a recheck), nothing otherwise. Only the second kind
  // leaves someone waiting for the answer, whatever version comes back.
  const kept = readings.get(program);
  const believed = kept !== undefined && kept.mtimeMs === stat.mtimeMs && kept.size === stat.size;
  const failedBefore = failures.has(program);
  // Behind a promise from the first step: a host that throws instead of rejecting must not break a provider list.
  const read = Promise.resolve().then(() => host.run(program, args)).then(
    (output) => {
      failures.delete(program);
      const version = readVersion(output);
      readings.set(program, { mtimeMs: stat.mtimeMs, size: stat.size, version });
      pending.delete(program);
      persist();
      if (!believed || kept.version !== version) for (const each of hosts) each.changed();
    },
    () => {
      pending.delete(program);
      failures.set(program, { at: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size });
      // From unknown to "cannot say": the candidate is passed over now, and a
      // later one may resolve. A retry that fails again changes nothing.
      if (!failedBefore) for (const each of hosts) each.changed();
    },
  );
  pending.set(program, read);
}

/**
 * A reading kept from an earlier run is believed, and checked against the
 * program once: at the first resolution that asks `RECHECK_AFTER_MS` or more
 * after the first one. The answer of that resolution is still the kept reading.
 */
function recheckWhenDue(program: string, args: string[]): void {
  if (fresh.has(program)) return;
  const at = due.get(program);
  if (at === undefined) due.set(program, Date.now() + RECHECK_AFTER_MS);
  else if (Date.now() >= at) start(program, args);
}

/**
 * The major version of the program at this path: a number once it is known,
 * null when the program answered with no version, cannot be reached or could
 * not be run, and undefined while it has not been asked yet, in which case the
 * question is on its way. A program that could not be run stays no candidate,
 * so the ones behind it get their turn, and is asked again in the background
 * once `RETRY_MS` has passed. `args` is what makes the program print its
 * version. With `ask` false nothing is ever started: the answer is what is
 * already known, for a provider that is turned off and must start nothing.
 */
export function majorAt(program: string, args: readonly string[], ask = true): number | null | undefined {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(program);
  } catch {
    return null;
  }
  const reading = readings.get(program);
  if (reading !== undefined && reading.mtimeMs === stat.mtimeMs && reading.size === stat.size) {
    if (ask) recheckWhenDue(program, [...args]);
    if (reading.version === null) return null;
    const major = Number.parseInt(reading.version, 10);
    return Number.isNaN(major) ? null : major;
  }
  const failed = failures.get(program);
  if (failed !== undefined && failed.mtimeMs === stat.mtimeMs && failed.size === stat.size) {
    // Asked before and it could not say: passed over, while a new try runs behind.
    if (ask && Date.now() - failed.at >= RETRY_MS) start(program, [...args]);
    return null;
  }
  // Another file than the one that failed: a new question, asked at once.
  if (failed !== undefined) failures.delete(program);
  if (ask) start(program, [...args]);
  return undefined;
}

/** Every reading is checked against its program at its next use: an agent was just updated. */
export function recheckVersions(): void {
  fresh.clear();
  for (const program of readings.keys()) due.set(program, 0);
}

/** A core that can run programs joins in. What was asked for before it came starts now. Returns the way out. */
export function attachVersions(host: VersionHost): () => void {
  loadVersions(host.file);
  hosts.add(host);
  for (const [program, args] of [...waiting]) {
    waiting.delete(program);
    start(program, args);
  }
  return () => {
    hosts.delete(host);
  };
}

/** Resolves once no version read is in flight, for a caller that would rather wait than miss a program. */
export async function versionsSettled(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending.values()]);
}

/** Every reading and every pending question dropped: a test starts from nothing. */
export function forgetVersions(): void {
  readings.clear();
  waiting.clear();
  failures.clear();
  fresh.clear();
  due.clear();
}
