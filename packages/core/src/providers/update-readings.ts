import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HarnessUpdate, ProviderId } from '@boite/contracts';

const SKIPS_FILE = 'harness-updates.json';
/** The last check's readings, so a restart shows them without spawning anything. */
const READINGS_FILE = 'harness-versions.json';

type Log = (level: 'warn', message: string) => void;

export interface Entry {
  route: HarnessUpdate['route'];
  current: string | null;
  latest: string | null;
  state: HarnessUpdate['state'];
  message: string | null;
  checkedAt: number | null;
  /** The program this reading came from. Null in a reading kept by an older build. */
  program: string | null;
}

export function readSkips(dataDir: string, log: Log): Record<string, string> {
  const file = join(dataDir, SKIPS_FILE);
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { skipped?: unknown };
    const out: Record<string, string> = {};
    if (typeof parsed.skipped === 'object' && parsed.skipped !== null) {
      for (const [key, value] of Object.entries(parsed.skipped)) if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch (error) {
    log('warn', `${file}: unreadable, expected {"skipped": {"<provider id>": "<version>"}}; no version is skipped (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
}

export function writeSkips(dataDir: string, skips: Record<string, string>): void {
  writeFileSync(join(dataDir, SKIPS_FILE), `${JSON.stringify({ skipped: skips }, null, 2)}\n`);
}

/** Loads the last check's readings into `entries`. A missing or broken file is no reading: the next check makes one. */
export function readReadings(dataDir: string, entries: Map<ProviderId, Entry>, log: Log): number | null {
  const file = join(dataDir, READINGS_FILE);
  if (!existsSync(file)) return null;
  let lastCheckAt: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { checkedAt?: unknown; readings?: unknown };
    if (typeof parsed.checkedAt === 'number' && Number.isFinite(parsed.checkedAt)) lastCheckAt = Math.min(parsed.checkedAt, Date.now());
    if (typeof parsed.readings !== 'object' || parsed.readings === null) return lastCheckAt;
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    for (const [id, raw] of Object.entries(parsed.readings as Record<string, Record<string, unknown> | null>)) {
      if (typeof raw !== 'object' || raw === null || (raw['route'] !== 'self' && raw['route'] !== 'managed')) continue;
      const failed = raw['state'] === 'failed';
      entries.set(id as ProviderId, {
        route: raw['route'],
        current: text(raw['current']),
        latest: text(raw['latest']),
        // A check or an update the last run left half done is only its last reading now.
        state: failed ? 'failed' : 'idle',
        message: failed ? text(raw['message']) : null,
        checkedAt: typeof raw['checkedAt'] === 'number' ? raw['checkedAt'] : null,
        program: text(raw['program']),
      });
    }
  } catch (error) {
    log('warn', `${file}: unreadable, expected {"checkedAt": <ms>, "readings": {"<provider id>": {...}}}; the next check reads again (${error instanceof Error ? error.message : String(error)})`);
  }
  return lastCheckAt;
}

export function writeReadings(dataDir: string, entries: ReadonlyMap<ProviderId, Entry>, lastCheckAt: number | null, log: Log): void {
  const readings: Record<string, Entry> = {};
  for (const [id, entry] of entries) {
    if (entry.state === 'checking' || entry.state === 'updating') continue;
    readings[id] = entry;
  }
  try {
    writeFileSync(join(dataDir, READINGS_FILE), `${JSON.stringify({ checkedAt: lastCheckAt, readings }, null, 2)}\n`);
  } catch (error) {
    log('warn', `writing ${READINGS_FILE}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
