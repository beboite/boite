import { existsSync } from 'node:fs';

/**
 * How long a PATH lookup is trusted. A program installed outside Boite (an
 * `npm i -g` in a terminal) shows up after this without a reload.
 */
const WHICH_TTL_MS = 30_000;
/** A bound on distinct lookups, far above what the shipped providers make. */
const WHICH_MAX_ENTRIES = 512;

let remembered = new Map<string, { at: number; hit: string | null }>();

/**
 * `Bun.which`, remembered per name and PATH. On Windows a miss walks every PATH
 * directory times every PATHEXT extension, and the provider list, every turn
 * start and every summary resolve the same names again. A remembered hit whose
 * file is gone is looked up again, so a spawn never gets a stale path.
 */
export function which(name: string, PATH = process.env['PATH'] ?? ''): string | null {
  const key = `${name}\0${PATH}`;
  const now = Date.now();
  const kept = remembered.get(key);
  if (kept !== undefined && now - kept.at < WHICH_TTL_MS && (kept.hit === null || existsSync(kept.hit))) return kept.hit;
  const hit = Bun.which(name, { PATH });
  if (remembered.size >= WHICH_MAX_ENTRIES) remembered = new Map();
  remembered.set(key, { at: now, hit });
  return hit;
}

/** Forgets every lookup: a reload, an install, an uninstall or an update may have moved a program. */
export function forgetWhich(): void {
  remembered = new Map();
}
