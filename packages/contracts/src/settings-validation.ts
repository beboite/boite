import type { GoalTrackerModel, ModelFavorite, ModelFavorites, Settings, SubscriptionProxy, TitleModel } from './index.ts';
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

/** A field's value refused, with the reason the caller is told. */
class Refusal {
  constructor(readonly message: string) {}
}
const refuse = (message: string) => new Refusal(message);

/** One setting's rule: the value as stored, or why it is refused. `next` holds the fields checked before it. */
type FieldRule<K extends keyof Settings> = (value: unknown, next: Partial<Settings>) => Settings[K] | Refusal;

export type SettingsPatchCheck =
  | { ok: true; patch: Partial<Settings> }
  /** `field` names the setting, an unknown key as it was sent, or `params` for a patch that is not an object. */
  | { ok: false; field: string; message: string };

/** Keys older clients and saved settings may still carry: dropped, never refused. */
const RETIRED_SETTINGS: readonly string[] = ['maxConcurrentTurns', 'perAccountConcurrency'];

const bool = (key: keyof Settings): FieldRule<keyof Settings> => value => typeof value === 'boolean' ? value : refuse(`${key} must be a boolean`);
const amount = (key: keyof Settings, max = Infinity): FieldRule<keyof Settings> => value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return refuse(`${key} must be a number of zero or more`);
  return value > max ? refuse(`${key} must be between 0 and ${max}`) : value;
};
const retentionDays = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3650;
/** One line of text, trimmed, or '' when it is not a string. */
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const record = (value: unknown): Record<string, unknown> | null => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function subscriptionProxyRule(value: unknown): Settings['subscriptionProxy'] | Refusal {
  if (value === null) return null;
  const proxy = record(value) as Partial<SubscriptionProxy> | null;
  if (proxy === null || typeof proxy.enabled !== 'boolean' || !['douane', 'cliproxyapi'].includes(proxy.kind as string)) {
    return refuse('subscriptionProxy must name douane or cliproxyapi and an enabled boolean');
  }
  const address = (raw: unknown, dashboard: boolean): string | null => {
    if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u001f]/.test(raw)) return null;
    try {
      const url = new URL(raw.trim());
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || (!dashboard && url.hash)) return null;
      return `${url.origin}${dashboard ? url.pathname : url.pathname.replace(/\/$/, '')}${dashboard ? url.hash : ''}`;
    } catch { return null; }
  };
  const mode: unknown = proxy.mode;
  if (mode !== undefined && mode !== 'remote' && mode !== 'local') return refuse('subscriptionProxy.mode must be remote, local or absent');
  if (mode === 'local' && proxy.kind !== 'douane') return refuse('subscriptionProxy.mode local runs Douane: kind must be douane');
  const baseUrl = address(proxy.baseUrl, false), dashboardUrl = address(proxy.dashboardUrl, true);
  if (!baseUrl || !dashboardUrl) return refuse('subscriptionProxy URLs must be HTTP or HTTPS addresses without credentials or query; only the dashboard may have a fragment');
  // Absent stays absent: settings saved before the local mode read as remote and compare unchanged.
  return { enabled: proxy.enabled, kind: proxy.kind!, baseUrl, dashboardUrl, ...(mode === undefined ? {} : { mode }) };
}

function worktreeStorageRule(value: unknown): Settings['worktreeStorage'] | Refusal {
  const storage = record(value);
  if (storage === null || !['project', 'shared'].includes(storage.mode as string)) return refuse('worktreeStorage.mode must be project or shared');
  const directory = typeof storage.directory === 'string' ? storage.directory.trim() : storage.directory;
  // Accept either host's absolute paths; the core checks its own OS before use.
  const absolute = typeof directory === 'string' && directory.length > 0 && !/[\u0000-\u001f]/.test(directory)
    && (/^\//.test(directory) || /^[a-z]:[\\/]/i.test(directory) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(directory));
  if (!absolute && !(storage.mode === 'project' && directory === null)) {
    return refuse('worktreeStorage.directory must be an absolute folder path, or null in project mode');
  }
  return { mode: storage.mode, directory } as Settings['worktreeStorage'];
}

function browserProfilesRule(value: unknown): BrowserProfile[] | Refusal {
  if (!Array.isArray(value) || value.length > BROWSER_PROFILES_MAX) return refuse(`browserProfiles must list at most ${BROWSER_PROFILES_MAX} profiles`);
  const profiles: BrowserProfile[] = [];
  for (const entry of value as Partial<BrowserProfile>[]) {
    const idError = browserProfileIdError(entry?.id);
    if (idError) return refuse(`browserProfiles: ${idError}`);
    const name = text(entry.name);
    if (browserProfileNameError(name)) return refuse(`browserProfiles: ${entry.id} needs a name of 1 to ${BROWSER_PROFILE_NAME_MAX} characters other than default or private`);
    if (profiles.some(profile => profile.id === entry.id || profile.name.toLowerCase() === name.toLowerCase())) {
      return refuse(`browserProfiles: ${entry.id} repeats another profile's id or name`);
    }
    const userAgentError = browserUserAgentError(entry.userAgent);
    if (userAgentError) return refuse(`browserProfiles: ${entry.id}: ${userAgentError}`);
    const userAgent = entry.userAgent?.value.trim() ? { mode: entry.userAgent.mode, value: entry.userAgent.value.trim() } : undefined;
    profiles.push({ id: entry.id as string, name, ...(userAgent ? { userAgent } : {}) });
  }
  return profiles;
}

function autoCompactRule(value: unknown): AutoCompact | null | Refusal {
  if (value === null) return null;
  const { tokens, moments } = (record(value) ?? {}) as Partial<AutoCompact>;
  const TOKENS = AUTO_COMPACT_TOKENS, MOMENTS: readonly AutoCompactMoment[] = AUTO_COMPACT_MOMENTS;
  if (!(tokens === null || (Number.isInteger(tokens) && tokens! >= TOKENS.min && tokens! <= TOKENS.max))) {
    return refuse(`autoCompact.tokens must be null or an integer between ${TOKENS.min} and ${TOKENS.max}`);
  }
  if (!(Array.isArray(moments) && (moments.length > 0 || tokens !== null) && moments.every(moment => MOMENTS.includes(moment)))) {
    return refuse(`autoCompact.moments must list only ${MOMENTS.join(', ')}; an empty list requires a token limit`);
  }
  return { tokens: tokens as number | null, moments: MOMENTS.filter(moment => moments.includes(moment)) };
}

function compactionByTypeRule(value: unknown): Settings['compactionByType'] | Refusal {
  const policies = record(value);
  if (policies === null) return refuse('compactionByType must be an object keyed by agent, subagent or bot');
  const normalized: NonNullable<Settings['compactionByType']> = {};
  for (const [target, raw] of Object.entries(policies)) {
    if (target !== 'agent' && target !== 'subagent' && target !== 'bot') return refuse(`compactionByType.${target}: expected agent, subagent or bot`);
    const policy = record(raw);
    if (policy === null) return refuse(`compactionByType.${target}: expected { autoCompact, backgroundCompaction }`);
    if (policy.autoCompact === undefined || typeof policy.backgroundCompaction !== 'boolean') return refuse(`compactionByType.${target}: expected autoCompact (a rule or null) and backgroundCompaction (a boolean)`);
    const autoCompact = autoCompactRule(policy.autoCompact);
    if (autoCompact instanceof Refusal) return refuse(`compactionByType.${target}.${autoCompact.message}`);
    normalized[target] = { autoCompact, backgroundCompaction: policy.backgroundCompaction };
  }
  return normalized;
}

/** A list of distinct strings, each `valid`, at most `max` of them; `map` applies before the repeats go. */
const list = (max: number, valid: (item: string) => boolean, message: string, map = (item: string) => item) => (value: unknown): string[] | Refusal =>
  Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && valid(item)) ? [...new Set((value as string[]).map(map))] : refuse(message);

/**
 * One rule per setting, in the order a patch is checked: `browserProfiles`
 * comes before the default profile it names. The mapped type keeps the table
 * complete: a setting added to `Settings` without a rule does not compile.
 */
const SETTING_RULES: { readonly [K in keyof Settings]-?: FieldRule<K> } = {
  subscriptionProxy: subscriptionProxyRule,
  quotaOrder: list(512, id => id.trim().length > 0 && id.length <= 200, 'quotaOrder must contain at most 512 non-empty account ids of at most 200 characters') as FieldRule<'quotaOrder'>,
  syncOverrides: list(SYNC_OVERRIDES_MAX, key => SYNC_KEY_PATTERN.test(key), `syncOverrides must list at most ${SYNC_OVERRIDES_MAX} keys: a setting, keybinding:<command> or brain:<switch>`),
  windowCaptureExclusions: list(100, app => app.trim().length > 0 && app.length <= 300 && !/\p{Cc}/u.test(app), 'windowCaptureExclusions must list at most 100 executable names or paths of 1 to 300 characters', app => app.trim()),
  worktreeStorage: worktreeStorageRule,
  publicUrl: value => {
    if (value === null) return null;
    return publicOrigin(value) ?? refuse('publicUrl must be an HTTPS origin without path, credentials, query or fragment');
  },
  browserOrigins: value => {
    const origins = Array.isArray(value) ? value.map(browserOrigin) : null;
    const unique = origins && !origins.includes(null) ? [...new Set(origins as string[])] : null;
    return unique === null || unique.length > BROWSER_ORIGINS_MAX ? refuse(`browserOrigins must contain at most ${BROWSER_ORIGINS_MAX} HTTP or HTTPS origins`) : unique;
  },
  browserProfiles: browserProfilesRule,
  browserDefaultProfile: (value, next) => {
    const known = value === DEFAULT_BROWSER_PROFILE || (browserProfileIdError(value) === null
      && (next.browserProfiles === undefined || next.browserProfiles.some(profile => profile.id === value)));
    return known ? value as string : refuse('browserDefaultProfile must be default or the id of a browser profile, never private');
  },
  warmProcessMinutes: amount('warmProcessMinutes') as FieldRule<'warmProcessMinutes'>,
  agentCpuCapPercent: amount('agentCpuCapPercent', 100) as FieldRule<'agentCpuCapPercent'>,
  threadMemoryCapMb: amount('threadMemoryCapMb') as FieldRule<'threadMemoryCapMb'>,
  agentMemoryBudgetPercent: value => typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 90 ? value
    : refuse('agentMemoryBudgetPercent must be an integer between 10 and 90'),
  memoryReserveMb: value => typeof value === 'number' && Number.isInteger(value) && (value === 0 || (value >= 256 && value <= 1048576)) ? value
    : refuse('memoryReserveMb must be 0 (auto) or an integer between 256 and 1048576 MB'),
  threadDoneRetentionDays: value => retentionDays(value) ? value as number
    : refuse('threadDoneRetentionDays must be an integer between 0 and 3650 days (0 disables automatic deletion)'),
  threadDeletionRetentionDays: value => retentionDays(value) ? value as number
    : refuse('threadDeletionRetentionDays must be an integer between 0 and 3650 days (0 keeps deleted conversations indefinitely)'),
  listenOnLan: bool('listenOnLan') as FieldRule<'listenOnLan'>,
  focusGuard: bool('focusGuard') as FieldRule<'focusGuard'>,
  muteAgents: bool('muteAgents') as FieldRule<'muteAgents'>,
  reapOrphans: bool('reapOrphans') as FieldRule<'reapOrphans'>,
  memoryProtection: bool('memoryProtection') as FieldRule<'memoryProtection'>,
  autoUpdateHarnesses: bool('autoUpdateHarnesses') as FieldRule<'autoUpdateHarnesses'>,
  autoInstallUpdates: bool('autoInstallUpdates') as FieldRule<'autoInstallUpdates'>,
  asyncQuestions: bool('asyncQuestions') as FieldRule<'asyncQuestions'>,
  shortAnswers: bool('shortAnswers') as FieldRule<'shortAnswers'>,
  toolSummaries: bool('toolSummaries') as FieldRule<'toolSummaries'>,
  agentLogAccess: bool('agentLogAccess') as FieldRule<'agentLogAccess'>,
  autoResumeLimitedThreads: bool('autoResumeLimitedThreads') as FieldRule<'autoResumeLimitedThreads'>,
  backgroundCompaction: bool('backgroundCompaction') as FieldRule<'backgroundCompaction'>,
  deviceStream: bool('deviceStream') as FieldRule<'deviceStream'>,
  groupThreads: bool('groupThreads') as FieldRule<'groupThreads'>,
  groupBots: bool('groupBots') as FieldRule<'groupBots'>,
  titleModel: value => {
    if (value === null) return null;
    const { providerId, model } = (record(value) ?? {}) as Partial<TitleModel>;
    if (!text(providerId) || !text(model) || text(model).length > TITLE_MODEL_MAX) {
      return refuse(`titleModel must be null or { providerId, model }, two non-empty strings, the model at most ${TITLE_MODEL_MAX} characters`);
    }
    return { providerId: text(providerId), model: text(model) };
  },
  goalTracker: value => {
    if (value === null) return null;
    const { providerId, model, effort } = (record(value) ?? {}) as Partial<GoalTrackerModel>;
    const level = effort === null || effort === undefined ? null : text(effort);
    if (!text(providerId) || !text(model) || text(model).length > TITLE_MODEL_MAX || level === '' || (level?.length ?? 0) > 40) {
      return refuse(`goalTracker must be null or { providerId, model, effort }: two non-empty strings, the model at most ${TITLE_MODEL_MAX} characters, and the effort a level name or null`);
    }
    return { providerId: text(providerId), model: text(model), effort: level };
  },
  autoCompact: autoCompactRule,
  compactionByType: compactionByTypeRule,
  cacheKeepalive: value => {
    if (value === null) return null;
    const { hours } = (record(value) ?? {}) as Partial<CacheKeepalive>;
    const HOURS = CACHE_KEEPALIVE_HOURS;
    return Number.isInteger(hours) && hours! >= HOURS.min && hours! <= HOURS.max ? { hours: hours! }
      : refuse(`cacheKeepalive must be null or { hours }, an integer between ${HOURS.min} and ${HOURS.max}`);
  },
  modelFavorites: value => checkModelFavorites(value)
    ?? refuse(`modelFavorites must be { at, items }: at a time in milliseconds, items at most ${MODEL_FAVORITES_MAX} of { providerId, model: { id, name }, account? }, each text 1 to ${FAVORITE_TEXT_MAX} characters on one line`),
};

/**
 * Pure validation of untrusted input, shared by the core and its in-memory
 * client: the patch as it is stored, each value normalized by its setting's
 * rule (`publicUrl` and `browserOrigins` reduced to bare origins), or the first
 * field it refuses. A key no rule knows is refused, retired keys are dropped
 * and an undefined value counts as absent, as it would on the wire.
 */
export function checkSettingsPatch(patch: unknown): SettingsPatchCheck {
  const input = record(patch);
  if (input === null) return { ok: false, field: 'params', message: 'settings: expected an object of settings' };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(SETTING_RULES, key) && !RETIRED_SETTINGS.includes(key)) return { ok: false, field: key, message: `${key} is not a setting this core knows` };
  }
  const next: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(SETTING_RULES) as [keyof Settings, FieldRule<keyof Settings>][]) {
    if (input[key] === undefined) continue;
    const value = rule(input[key], next as Partial<Settings>);
    if (value instanceof Refusal) return { ok: false, field: key, message: value.message };
    next[key] = value;
  }
  return { ok: true, patch: next as Partial<Settings> };
}
