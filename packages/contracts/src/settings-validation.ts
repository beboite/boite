import type { Settings } from './index.ts';

// Both supported hosts expose URL; contracts otherwise need no DOM or Node types.
declare const URL: new (value: string) => {
  protocol: string; username: string; password: string; search: string; hash: string; pathname: string; origin: string;
};

export const BROWSER_ORIGINS_MAX = 32;

const NUMERIC_KEYS = ['maxConcurrentTurns', 'perAccountConcurrency', 'warmProcessMinutes', 'agentCpuCapPercent', 'threadMemoryCapMb'] as const;
const POSITIVE_KEYS = ['maxConcurrentTurns', 'perAccountConcurrency'] as const;
const BOOLEAN_KEYS = ['listenOnLan', 'focusGuard', 'muteAgents', 'reapOrphans', 'autoUpdateHarnesses', 'asyncQuestions'] as const;
/** Keys whose value is a percentage of the machine, so anything past 100 is a mistake. */
const PERCENT_KEYS = ['agentCpuCapPercent'] as const;

export type SettingsPatchCheck =
  | { ok: true; patch: Partial<Settings> }
  | { ok: false; field: keyof Settings; message: string };

/**
 * The public address as an origin. A copy from the address bar ends in `/`,
 * which is the same origin and is accepted; a real path is refused, because a
 * pairing link built on a proxy's subpath would not open Boite.
 */
function publicOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** A browser's `Origin` header never carries a path, so any path pasted with one is dropped. */
function browserOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Pure validation shared by the core and its in-memory client: the patch as it
 * is stored, with `publicUrl` and `browserOrigins` reduced to bare origins, or
 * the first field it refuses.
 */
export function checkSettingsPatch(patch: Partial<Settings>): SettingsPatchCheck {
  const next: Partial<Settings> = { ...patch };
  if (patch.publicUrl !== undefined && patch.publicUrl !== null) {
    const origin = publicOrigin(patch.publicUrl);
    if (origin === null) {
      return { ok: false, field: 'publicUrl', message: 'publicUrl must be an HTTPS origin without path, credentials, query or fragment' };
    }
    next.publicUrl = origin;
  }
  if (patch.browserOrigins !== undefined) {
    const origins = Array.isArray(patch.browserOrigins) ? patch.browserOrigins.map(browserOrigin) : null;
    const unique = origins && !origins.includes(null) ? [...new Set(origins as string[])] : null;
    if (unique === null || unique.length > BROWSER_ORIGINS_MAX) {
      return { ok: false, field: 'browserOrigins', message: `browserOrigins must contain at most ${BROWSER_ORIGINS_MAX} HTTP or HTTPS origins` };
    }
    next.browserOrigins = unique;
  }
  for (const key of POSITIVE_KEYS) {
    const value = patch[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) return { ok: false, field: key, message: `${key} must be a positive integer` };
  }
  for (const key of NUMERIC_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, field: key, message: `${key} must be a number of zero or more` };
  }
  for (const key of PERCENT_KEYS) {
    const value = patch[key];
    if (value !== undefined && value > 100) return { ok: false, field: key, message: `${key} must be between 0 and 100` };
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key];
    if (value !== undefined && typeof value !== 'boolean') return { ok: false, field: key, message: `${key} must be a boolean` };
  }
  return { ok: true, patch: next };
}
