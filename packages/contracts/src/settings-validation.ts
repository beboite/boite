import type { GoalTrackerModel, ModelFavorite, ModelFavorites, Settings, TitleModel } from './index.ts';
import { BROWSER_PROFILE_NAME_MAX, BROWSER_PROFILES_MAX, browserProfileIdError, browserProfileNameError, browserUserAgentError, DEFAULT_BROWSER_PROFILE, type BrowserProfile } from './browser';
import { SYNC_KEY_PATTERN, SYNC_OVERRIDES_MAX } from './settings-sync';

// Both supported hosts expose URL; contracts otherwise need no DOM or Node types.
declare const URL: new (value: string) => {
  protocol: string; username: string; password: string; search: string; hash: string; pathname: string; origin: string;
};

export const BROWSER_ORIGINS_MAX = 32;
/** A model id is a name, never a paragraph. */
const TITLE_MODEL_MAX = 200;
/** Starred models kept for all of the owner's machines. */
export const MODEL_FAVORITES_MAX = 200;
/** A provider id, model id, model name or account label in a favorite. */
const FAVORITE_TEXT_MAX = 200;

/** One line of printable text of 1 to `FAVORITE_TEXT_MAX` characters, trimmed, or null. */
function favoriteText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= FAVORITE_TEXT_MAX && !/[\u0000-\u001f]/.test(text) ? text : null;
}

/**
 * Which of two favorite lists wins, above zero when `a` does: the later `at`,
 * then the greater content, so two lists of the same time never flip back and
 * forth. Missing reads as the empty list of time 0. Core and clients decide alike.
 */
export function compareModelFavorites(a: ModelFavorites | null | undefined, b: ModelFavorites | null | undefined): number {
  const left = a ?? { at: 0, items: [] }, right = b ?? { at: 0, items: [] };
  if (left.at !== right.at) return left.at - right.at;
  const content = (list: ModelFavorites) => JSON.stringify(list.items.map(item => [item.providerId, item.model.id, item.model.name, item.account ?? null]));
  const x = content(left), y = content(right);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * The patch to store over `stored`: a favorite list that loses to the stored
 * one is dropped, so two clients writing at once leave the later list.
 */
export function keepLaterFavorites(stored: Settings, patch: Partial<Settings>): Partial<Settings> {
  if (patch.modelFavorites === undefined || compareModelFavorites(patch.modelFavorites, stored.modelFavorites) >= 0) return patch;
  const { modelFavorites: _older, ...rest } = patch;
  return rest;
}

/** The favorites as stored: each field trimmed, unknown keys dropped, a repeat kept once. Null when one is malformed. */
function checkModelFavorites(value: unknown): Settings['modelFavorites'] | null {
  if (typeof value !== 'object' || value === null) return null;
  const { at, items } = value as { at?: unknown; items?: unknown };
  if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || !Array.isArray(items) || items.length > MODEL_FAVORITES_MAX) return null;
  const kept: ModelFavorite[] = [];
  const seen = new Set<string>();
  for (const raw of items as Partial<ModelFavorite>[]) {
    if (typeof raw !== 'object' || raw === null) return null;
    const providerId = favoriteText(raw.providerId), id = favoriteText(raw.model?.id), name = favoriteText(raw.model?.name);
    const account = raw.account === undefined ? undefined : favoriteText(raw.account);
    if (providerId === null || id === null || name === null || account === null) return null;
    const key = JSON.stringify([providerId, id, account ?? null]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ providerId, model: { id, name }, ...(account === undefined ? {} : { account }) });
  }
  return { at, items: kept };
}

/**
 * The moments the core can compact at. All of them sit between two turns: the
 * core never cuts into a running one, where the agent's own compaction rules.
 * - `turn-end`: the agent answered and left nothing running.
 * - `background`: the agent answered and waits on work it left running (a
 *   shell, a monitor), so the compaction uses time nobody is waiting for.
 * - `cache-expiry`: the thread stayed idle until its prompt cache was about to
 *   lapse, so the compaction reads the conversation at the cached price and
 *   the next message does not pay for the whole of it again.
 */
export const AUTO_COMPACT_MOMENTS = ['turn-end', 'background', 'cache-expiry'] as const;
export type AutoCompactMoment = (typeof AUTO_COMPACT_MOMENTS)[number];
/** The bounds of `AutoCompact.tokens`. */
export const AUTO_COMPACT_TOKENS = { min: 1_000, max: 10_000_000 } as const;

export interface AutoCompact {
  /**
   * Independent token limit: compact at the next safe native tool boundary
   * when supported, otherwise between turns, even without a selected idle
   * moment. Also gates turn-end/background; cache-expiry is independent.
   * Null leaves only the selected idle moments.
   */
  tokens: number | null;
  /** Each listed once. Empty is allowed when a token limit supplies its own trigger. */
  moments: AutoCompactMoment[];
}

/** The bounds of `CacheKeepalive.hours`, and what the setting offers first. */
export const CACHE_KEEPALIVE_HOURS = { min: 1, max: 24, default: 12 } as const;

export interface CacheKeepalive {
  /**
   * How long a thread's prompt cache is kept warm while it waits on its
   * delegated agents or workflows, counted from the end of its last turn.
   */
  hours: number;
}

const NUMERIC_KEYS = ['warmProcessMinutes', 'agentCpuCapPercent', 'threadMemoryCapMb', 'agentMemoryBudgetPercent', 'memoryReserveMb'] as const;
const BOOLEAN_KEYS = ['listenOnLan', 'focusGuard', 'muteAgents', 'reapOrphans', 'memoryProtection', 'autoUpdateHarnesses', 'autoInstallUpdates', 'asyncQuestions', 'shortAnswers', 'toolSummaries', 'agentLogAccess', 'autoResumeLimitedThreads', 'backgroundCompaction', 'deviceStream', 'groupThreads', 'groupBots'] as const;
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
  if (patch.subscriptionProxy !== undefined && patch.subscriptionProxy !== null) {
    const proxy = patch.subscriptionProxy;
    if (typeof proxy !== 'object' || typeof proxy.enabled !== 'boolean' || !['douane', 'cliproxyapi'].includes(proxy.kind)) {
      return { ok: false, field: 'subscriptionProxy', message: 'subscriptionProxy must name douane or cliproxyapi and an enabled boolean' };
    }
    const address = (value: unknown, dashboard: boolean): string | null => {
      if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u001f]/.test(value)) return null;
      try {
        const url = new URL(value.trim());
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || (!dashboard && url.hash)) return null;
        return `${url.origin}${dashboard ? url.pathname : url.pathname.replace(/\/$/, '')}${dashboard ? url.hash : ''}`;
      } catch { return null; }
    };
    const mode: unknown = (proxy as { mode?: unknown }).mode;
    if (mode !== undefined && mode !== 'remote' && mode !== 'local') {
      return { ok: false, field: 'subscriptionProxy', message: 'subscriptionProxy.mode must be remote, local or absent' };
    }
    if (mode === 'local' && proxy.kind !== 'douane') {
      return { ok: false, field: 'subscriptionProxy', message: 'subscriptionProxy.mode local runs Douane: kind must be douane' };
    }
    const baseUrl = address(proxy.baseUrl, false), dashboardUrl = address(proxy.dashboardUrl, true);
    if (!baseUrl || !dashboardUrl) return { ok: false, field: 'subscriptionProxy', message: 'subscriptionProxy URLs must be HTTP or HTTPS addresses without credentials or query; only the dashboard may have a fragment' };
    // Absent stays absent: settings saved before the local mode read as remote and compare unchanged.
    next.subscriptionProxy = { enabled: proxy.enabled, kind: proxy.kind, baseUrl, dashboardUrl, ...(mode === undefined ? {} : { mode }) };
  }
  // Older clients and saved settings may still carry the retired launch limits.
  Reflect.deleteProperty(next, 'maxConcurrentTurns');
  Reflect.deleteProperty(next, 'perAccountConcurrency');
  if (patch.quotaOrder !== undefined) {
    const order = patch.quotaOrder;
    if (!Array.isArray(order) || order.length > 512 || order.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200)) {
      return { ok: false, field: 'quotaOrder', message: 'quotaOrder must contain at most 512 non-empty account ids of at most 200 characters' };
    }
    next.quotaOrder = [...new Set(order)];
  }
  if (patch.syncOverrides !== undefined) {
    const keys: unknown = patch.syncOverrides;
    if (!Array.isArray(keys) || keys.length > SYNC_OVERRIDES_MAX || keys.some((key) => typeof key !== 'string' || !SYNC_KEY_PATTERN.test(key))) {
      return { ok: false, field: 'syncOverrides', message: `syncOverrides must list at most ${SYNC_OVERRIDES_MAX} keys: a setting, keybinding:<command> or brain:<switch>` };
    }
    next.syncOverrides = [...new Set(keys as string[])];
  }
  if (patch.windowCaptureExclusions !== undefined) {
    const apps: unknown = patch.windowCaptureExclusions;
    if (!Array.isArray(apps) || apps.length > 100 || apps.some((app) => typeof app !== 'string' || !app.trim() || app.length > 300 || /\p{Cc}/u.test(app))) {
      return { ok: false, field: 'windowCaptureExclusions', message: 'windowCaptureExclusions must list at most 100 executable names or paths of 1 to 300 characters' };
    }
    next.windowCaptureExclusions = [...new Set((apps as string[]).map((app) => app.trim()))];
  }
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
  if (patch.browserProfiles !== undefined) {
    const raw: unknown = patch.browserProfiles;
    const profiles: BrowserProfile[] = [];
    if (!Array.isArray(raw) || raw.length > BROWSER_PROFILES_MAX) {
      return { ok: false, field: 'browserProfiles', message: `browserProfiles must list at most ${BROWSER_PROFILES_MAX} profiles` };
    }
    for (const entry of raw as Partial<BrowserProfile>[]) {
      const idError = browserProfileIdError(entry?.id);
      if (idError) return { ok: false, field: 'browserProfiles', message: `browserProfiles: ${idError}` };
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (browserProfileNameError(name)) {
        return { ok: false, field: 'browserProfiles', message: `browserProfiles: ${entry.id} needs a name of 1 to ${BROWSER_PROFILE_NAME_MAX} characters other than default or private` };
      }
      if (profiles.some(profile => profile.id === entry.id || profile.name.toLowerCase() === name.toLowerCase())) {
        return { ok: false, field: 'browserProfiles', message: `browserProfiles: ${entry.id} repeats another profile's id or name` };
      }
      const userAgentError = browserUserAgentError(entry.userAgent);
      if (userAgentError) return { ok: false, field: 'browserProfiles', message: `browserProfiles: ${entry.id}: ${userAgentError}` };
      const userAgent = entry.userAgent?.value.trim() ? { mode: entry.userAgent.mode, value: entry.userAgent.value.trim() } : undefined;
      profiles.push({ id: entry.id as string, name, ...(userAgent ? { userAgent } : {}) });
    }
    next.browserProfiles = profiles;
  }
  if (patch.browserDefaultProfile !== undefined) {
    const wanted = patch.browserDefaultProfile;
    const known = wanted === DEFAULT_BROWSER_PROFILE || (browserProfileIdError(wanted) === null
      && (next.browserProfiles === undefined || next.browserProfiles.some(profile => profile.id === wanted)));
    if (!known) return { ok: false, field: 'browserDefaultProfile', message: 'browserDefaultProfile must be default or the id of a browser profile, never private' };
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
  const doneRetention = patch.threadDoneRetentionDays;
  if (doneRetention !== undefined && (!Number.isInteger(doneRetention) || doneRetention < 0 || doneRetention > 3650)) {
    return { ok: false, field: 'threadDoneRetentionDays', message: 'threadDoneRetentionDays must be an integer between 0 and 3650 days (0 disables automatic deletion)' };
  }
  const retention = patch.threadDeletionRetentionDays;
  if (retention !== undefined && (!Number.isInteger(retention) || retention < 0 || retention > 3650)) {
    return { ok: false, field: 'threadDeletionRetentionDays', message: 'threadDeletionRetentionDays must be an integer between 0 and 3650 days (0 keeps deleted conversations indefinitely)' };
  }
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
  if (patch.goalTracker !== undefined && patch.goalTracker !== null) {
    const { providerId, model, effort } = (typeof patch.goalTracker === 'object' ? patch.goalTracker : {}) as Partial<GoalTrackerModel>;
    const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
    const level = effort === null || effort === undefined ? null : text(effort);
    if (text(providerId).length === 0 || text(model).length === 0 || text(model).length > TITLE_MODEL_MAX || level === '' || (level?.length ?? 0) > 40) {
      return { ok: false, field: 'goalTracker', message: `goalTracker must be null or { providerId, model, effort }: two non-empty strings, the model at most ${TITLE_MODEL_MAX} characters, and the effort a level name or null` };
    }
    next.goalTracker = { providerId: text(providerId), model: text(model), effort: level };
  }
  if (patch.autoCompact !== undefined && patch.autoCompact !== null) {
    const { tokens, moments } = (typeof patch.autoCompact === 'object' ? patch.autoCompact : {}) as Partial<AutoCompact>;
    const TOKENS = AUTO_COMPACT_TOKENS, MOMENTS: readonly AutoCompactMoment[] = AUTO_COMPACT_MOMENTS;
    const sized = tokens === null || (Number.isInteger(tokens) && tokens! >= TOKENS.min && tokens! <= TOKENS.max);
    if (!sized) {
      return { ok: false, field: 'autoCompact', message: `autoCompact.tokens must be null or an integer between ${TOKENS.min} and ${TOKENS.max}` };
    }
    const known = Array.isArray(moments) && (moments.length > 0 || tokens !== null) && moments.every((moment) => MOMENTS.includes(moment));
    if (!known) {
      return { ok: false, field: 'autoCompact', message: `autoCompact.moments must list only ${MOMENTS.join(', ')}; an empty list requires a token limit` };
    }
    next.autoCompact = { tokens: tokens as number | null, moments: MOMENTS.filter((moment) => moments.includes(moment)) };
  }
  if (patch.compactionByType !== undefined) {
    const policies: unknown = patch.compactionByType;
    const fail = (message: string): SettingsPatchCheck => ({ ok: false, field: 'compactionByType', message });
    if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) return fail('compactionByType must be an object keyed by agent, subagent or bot');
    const normalized: NonNullable<Settings['compactionByType']> = {};
    for (const [target, raw] of Object.entries(policies)) {
      if (target !== 'agent' && target !== 'subagent' && target !== 'bot') return fail(`compactionByType.${target}: expected agent, subagent or bot`);
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return fail(`compactionByType.${target}: expected { autoCompact, backgroundCompaction }`);
      const policy = raw as Record<string, unknown>;
      if (policy.autoCompact === undefined || typeof policy.backgroundCompaction !== 'boolean') return fail(`compactionByType.${target}: expected autoCompact (a rule or null) and backgroundCompaction (a boolean)`);
      const checked = checkSettingsPatch({ autoCompact: policy.autoCompact as AutoCompact | null });
      if (!checked.ok) return fail(`compactionByType.${target}.${checked.message}`);
      normalized[target] = { autoCompact: checked.patch.autoCompact ?? null, backgroundCompaction: policy.backgroundCompaction };
    }
    next.compactionByType = normalized;
  }
  if (patch.cacheKeepalive !== undefined && patch.cacheKeepalive !== null) {
    const { hours } = (typeof patch.cacheKeepalive === 'object' ? patch.cacheKeepalive : {}) as Partial<CacheKeepalive>;
    const HOURS = CACHE_KEEPALIVE_HOURS;
    if (!Number.isInteger(hours) || hours! < HOURS.min || hours! > HOURS.max) {
      return { ok: false, field: 'cacheKeepalive', message: `cacheKeepalive must be null or { hours }, an integer between ${HOURS.min} and ${HOURS.max}` };
    }
    next.cacheKeepalive = { hours: hours! };
  }
  if (patch.modelFavorites !== undefined) {
    const favorites = checkModelFavorites(patch.modelFavorites);
    if (favorites === null) {
      return { ok: false, field: 'modelFavorites', message: `modelFavorites must be { at, items }: at a time in milliseconds, items at most ${MODEL_FAVORITES_MAX} of { providerId, model: { id, name }, account? }, each text 1 to ${FAVORITE_TEXT_MAX} characters on one line` };
    }
    next.modelFavorites = favorites;
  }
  return { ok: true, patch: next };
}
