import type { Settings, TitleModel } from './index.ts';

// Both supported hosts expose URL; contracts otherwise need no DOM or Node types.
declare const URL: new (value: string) => {
  protocol: string; username: string; password: string; search: string; hash: string; pathname: string; origin: string;
};

export const BROWSER_ORIGINS_MAX = 32;
/** A model id is a name, never a paragraph. */
const TITLE_MODEL_MAX = 200;

const NUMERIC_KEYS = ['warmProcessMinutes', 'agentCpuCapPercent', 'threadMemoryCapMb', 'agentMemoryBudgetPercent', 'memoryReserveMb'] as const;
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
  // Older clients and saved settings may still carry the retired launch limits.
  Reflect.deleteProperty(next, 'maxConcurrentTurns');
  Reflect.deleteProperty(next, 'perAccountConcurrency');
  if (patch.worktreeStorage !== undefined) {
    const storage = patch.worktreeStorage;
    if (!storage || typeof storage !== 'object' || !['project', 'shared'].includes(storage.mode)) {
      return { ok: false, field: 'worktreeStorage', message: 'worktreeStorage.mode must be project or shared' };
    }
    const directory = typeof storage.directory === 'string' ? storage.directory.trim() : storage.directory;
    // Accept either host's absolute paths; the core checks its own OS before use.
    const absolute = typeof directory === 'string' && directory.length > 0 && !/[\u0000-\u001f]/.test(directory)
      && (/^\//.test(directory) || /^[a-z]:[\\/]/i.test(directory) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory));
    if (!absolute && !(storage.mode === 'project' && directory === null)) {
      return { ok: false, field: 'worktreeStorage', message: 'worktreeStorage.directory must be an absolute folder path, or null in project mode' };
    }
    next.worktreeStorage = { mode: storage.mode, directory } as Settings['worktreeStorage'];
  }
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
  for (const key of NUMERIC_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, field: key, message: `${key} must be a number of zero or more` };
  }
  for (const key of PERCENT_KEYS) {
    const value = patch[key];
    if (value !== undefined && value > 100) return { ok: false, field: key, message: `${key} must be between 0 and 100` };
  }
  const budget = patch.agentMemoryBudgetPercent;
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 10 || budget > 90)) {
    return { ok: false, field: 'agentMemoryBudgetPercent', message: 'agentMemoryBudgetPercent must be an integer between 10 and 90' };
  }
  const reserve = patch.memoryReserveMb;
  if (reserve !== undefined && (!Number.isInteger(reserve) || (reserve !== 0 && (reserve < 256 || reserve > 1048576)))) {
    return { ok: false, field: 'memoryReserveMb', message: 'memoryReserveMb must be 0 (auto) or an integer between 256 and 1048576 MB' };
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key];
    if (value !== undefined && typeof value !== 'boolean') return { ok: false, field: key, message: `${key} must be a boolean` };
  }
  if (patch.titleModel !== undefined && patch.titleModel !== null) {
    const { providerId, model } = patch.titleModel as Partial<TitleModel>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    if (typeof patch.titleModel !== 'object' || text(providerId).length === 0 || text(model).length === 0 || text(model).length > TITLE_MODEL_MAX) {
      return { ok: false, field: 'titleModel', message: `titleModel must be null or { providerId, model }, two non-empty strings, the model at most ${TITLE_MODEL_MAX} characters` };
    }
    next.titleModel = { providerId: text(providerId), model: text(model) };
  }
  return { ok: true, patch: next };
}
