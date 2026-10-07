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
 * of the core, a little after its first use, and again after an agent update
 * (`recheckVersions`).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/;
/** A program that could not be asked is asked again after this long, not at every resolution. */
const RETRY_MS = 60_000;
/** How long after its first use a kept reading is checked against the program, so nothing extra runs while the core starts. */
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
const failures = new Map<string, number>();
const hosts = new Set<VersionHost>();
/** Paths whose reading this run already took from the program itself, or is about to. */
const fresh = new Set<string>();

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
  const read = host.run(program, args).then(
    (output) => {
      failures.delete(program);
      const before = readings.get(program)?.version;
      const version = readVersion(output);
      readings.set(program, { mtimeMs: stat.mtimeMs, size: stat.size, version });
      pending.delete(program);
      persist();
      if (before !== version) for (const each of hosts) each.changed();
    },
    () => {
      pending.delete(program);
      failures.set(program, Date.now());
      // From unknown to "cannot say": the candidate is passed over now, and a later one may resolve.
      for (const each of hosts) each.changed();
    },
  );
  pending.set(program, read);
}

/** A reading kept from an earlier run is believed now and checked against the program once, shortly. */
function recheckLater(program: string, args: string[]): void {
  if (fresh.has(program)) return;
  fresh.add(program);
  const timer = setTimeout(() => {
    fresh.delete(program);
    start(program, args);
  }, RECHECK_AFTER_MS);
  timer.unref?.();
}

/**
 * The major version of the program at this path: a number once it is known,
 * null when the program answered with no version, cannot be reached or could
 * not be run a moment ago, and undefined while it has not been asked yet, in
 * which case the question is on its way. A program that could not be run is
 * asked again once `RETRY_MS` has passed; until then it is no candidate, so
 * the ones behind it get their turn. `args` is what makes the program print
 * its version.
 */
export function majorAt(program: string, args: readonly string[]): number | null | undefined {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(program);
  } catch {
    return null;
  }
  const reading = readings.get(program);
  if (reading !== undefined && reading.mtimeMs === stat.mtimeMs && reading.size === stat.size) {
    recheckLater(program, [...args]);
    if (reading.version === null) return null;
    const major = Number.parseInt(reading.version, 10);
    return Number.isNaN(major) ? null : major;
  }
  const failedAt = failures.get(program);
  if (failedAt !== undefined && Date.now() - failedAt < RETRY_MS) return null;
  start(program, [...args]);
  return undefined;
}

/** Every reading is checked against its program at its next use: an agent was just updated. */
export function recheckVersions(): void {
  fresh.clear();
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
}
