import type { QuestionAnswer, QuestionOption, Settings, ThreadId } from './index.ts';

/*
 * An agent helping the user set Boite up: it reads the settings, then asks for
 * a change with a card in the conversation (`boite settings request`) or
 * points at a Settings page (`boite settings open`). The card never writes
 * anything itself. Apply calls `settings.set`, which only the owner reaches,
 * and the core settles the card when the value it asked about changes, from
 * the card or from the page. See docs/cli.md.
 */

/** The Settings pages a card can open, under the ids the app's navigation uses. */
export const SETTINGS_PAGES = [
  'general', 'appearance', 'keyboard', 'voice', 'accounts', 'plugins', 'brain',
  'usage', 'limits', 'task-manager', 'resources', 'machines', 'advanced', 'experiments',
] as const;
export type SettingsPage = (typeof SETTINGS_PAGES)[number];

/** Where one setting is drawn, and whether its card may apply it in one click. */
export interface SettingPlace {
  page: SettingsPage;
  /** The card's anchor on that page, `settings-<section>` in the DOM. */
  section: string;
  /**
   * The card offers no Apply: it opens the page, where the setting sits beside
   * its explanation. Network reach, the guards that keep agents quiet, history
   * retention and where worktrees are written.
   */
  sensitive: boolean;
}

/**
 * The settings an agent may read and ask about. Credentials, account ids and
 * browser profiles are left out: an agent has no reason to read them.
 */
export const REQUESTABLE_SETTINGS = {
  asyncQuestions: { page: 'general', section: 'conversations', sensitive: false },
  shortAnswers: { page: 'general', section: 'conversations', sensitive: false },
  titleModel: { page: 'general', section: 'conversations', sensitive: false },
  threadDoneRetentionDays: { page: 'general', section: 'archived', sensitive: true },
  threadDeletionRetentionDays: { page: 'general', section: 'archived', sensitive: true },
  worktreeStorage: { page: 'general', section: 'worktrees', sensitive: true },
  focusGuard: { page: 'resources', section: 'quiet', sensitive: true },
  muteAgents: { page: 'resources', section: 'quiet', sensitive: true },
  agentCpuCapPercent: { page: 'resources', section: 'limits', sensitive: false },
  agentMemoryBudgetPercent: { page: 'resources', section: 'limits', sensitive: false },
  threadMemoryCapMb: { page: 'resources', section: 'limits', sensitive: false },
  memoryReserveMb: { page: 'resources', section: 'limits', sensitive: false },
  memoryProtection: { page: 'resources', section: 'limits', sensitive: true },
  reapOrphans: { page: 'resources', section: 'tasks', sensitive: false },
  autoUpdateHarnesses: { page: 'machines', section: 'machines', sensitive: false },
  listenOnLan: { page: 'machines', section: 'phone', sensitive: true },
  publicUrl: { page: 'machines', section: 'phone', sensitive: true },
  browserOrigins: { page: 'advanced', section: 'origins', sensitive: true },
  warmProcessMinutes: { page: 'advanced', section: 'execution', sensitive: false },
  autoCompact: { page: 'advanced', section: 'auto-compact', sensitive: false },
  autoResumeLimitedThreads: { page: 'limits', section: 'limit-resume', sensitive: false },
} as const satisfies Partial<Record<keyof Settings, SettingPlace>>;

export type RequestableSetting = keyof typeof REQUESTABLE_SETTINGS;
export const REQUESTABLE_SETTING_KEYS = Object.keys(REQUESTABLE_SETTINGS) as RequestableSetting[];

export function isRequestableSetting(key: unknown): key is RequestableSetting {
  return typeof key === 'string' && Object.hasOwn(REQUESTABLE_SETTINGS, key);
}

export function isSettingsPage(page: unknown): page is SettingsPage {
  return typeof page === 'string' && (SETTINGS_PAGES as readonly string[]).includes(page);
}

/** A section anchor as the app writes them: lowercase words joined by dashes. */
export const SETTINGS_SECTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** One readable setting, as `agent.settings` lists it. */
export interface SettingReading extends SettingPlace {
  key: RequestableSetting;
  /** The value now; null where the core keeps none and uses its default. */
  value: unknown;
}

/**
 * What a settings card carries, beside the question's text, which is the
 * agent's reason. `change` proposes a value for one key; `open` only points at
 * a page, for what is not a single value: a provider login, a pairing.
 */
export type SettingAsk =
  | {
      kind: 'change';
      key: RequestableSetting;
      /** The proposed value, as `settings.set` would store it. */
      value: unknown;
      /** The value when the agent asked, null when unset. The card settles when the setting leaves it. */
      previous: unknown;
      page: SettingsPage;
      section: string;
      sensitive: boolean;
    }
  | { kind: 'open'; page: SettingsPage; section: string | null };

/**
 * How a settings card ended, the one option id its answer carries. Only
 * `refuse` and `open` are options the user answers with; the core writes
 * `applied` and `changed` itself when the setting changes.
 */
export type SettingOutcome = 'applied' | 'changed' | 'refuse' | 'open';

export const SETTING_REASON_MAX = 500;

/** Params of `settings.request`: a change of one key, or a page to open. */
export type SettingRequestParams = { threadId: ThreadId; reason: string } & (
  | { key: string; value: unknown; page?: never; section?: never }
  | { page: string; section?: string | null; key?: never; value?: never }
);

/** What a missing key means, for the keys the core's defaults leave out. */
const MISSING: Partial<Record<RequestableSetting, unknown>> = {
  asyncQuestions: true,
  autoResumeLimitedThreads: false,
  shortAnswers: true,
  titleModel: null,
  autoCompact: null,
  publicUrl: null,
  browserOrigins: [],
};

/** The value a setting has in effect: a missing key reads as its default, null when it has none. */
export function effectiveSetting(settings: Settings, key: RequestableSetting): unknown {
  const value = settings[key] === undefined ? (MISSING[key] ?? null) : settings[key];
  // A copy of a list or an object: a card keeps it, and a caller that sorts or
  // pushes must change neither the settings nor the default. Settings are JSON.
  return value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

export function readSettings(settings: Settings): SettingReading[] {
  return REQUESTABLE_SETTING_KEYS.map(key => ({ key, value: effectiveSetting(settings, key), ...REQUESTABLE_SETTINGS[key] }));
}

/** Same JSON whatever the order of an object's keys; undefined reads as null. */
export function sameSetting(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([name, item]) => `${JSON.stringify(name)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export type SettingRequestCheck =
  | { ok: true; reason: string; setting: SettingAsk; options: QuestionOption[] }
  | { ok: false; message: string; data: Record<string, unknown> };

/** A patch as `settings.set` would store it, or its refusal. */
export type SettingNormalizer = (patch: Partial<Settings>) => { ok: true; patch: Partial<Settings> } | { ok: false; message: string; field: string };

/**
 * `settings.request` checked, by the core and the in-memory client alike.
 * `normalize` is the store's own validation; `open` lists the change cards
 * the thread already has open, one per key at most.
 */
export function checkSettingRequest(params: SettingRequestParams, settings: Settings, normalize: SettingNormalizer, open: readonly SettingAsk[]): SettingRequestCheck {
  const reason = typeof params.reason === 'string' ? params.reason.trim() : '';
  if (reason.length === 0 || reason.length > SETTING_REASON_MAX) return { ok: false, message: `reason must hold 1 to ${SETTING_REASON_MAX} characters`, data: { field: 'reason' } };
  const hasKey = params.key !== undefined;
  if (hasKey === (params.page !== undefined)) return { ok: false, message: 'settings.request takes a key and a value, or a page', data: { field: 'key', expected: 'key or page' } };
  if (!hasKey) {
    const { page, section } = params;
    if (!isSettingsPage(page)) return { ok: false, message: `${String(page)} is not a Settings page`, data: { field: 'page', expected: SETTINGS_PAGES } };
    if (section !== undefined && section !== null && (typeof section !== 'string' || section.length > 64 || !SETTINGS_SECTION_PATTERN.test(section))) {
      return { ok: false, message: 'section must be a card anchor of lowercase words joined by dashes', data: { field: 'section', expected: 'such as limits or provider-claude' } };
    }
    return {
      ok: true, reason, setting: { kind: 'open', page, section: typeof section === 'string' ? section : null },
      options: [{ id: 'open', label: 'Open Settings' }, { id: 'refuse', label: 'Dismiss' }],
    };
  }
  const { key, value } = params;
  if (!isRequestableSetting(key)) {
    return { ok: false, message: `${String(key)} is not a setting an agent may ask about; the keys are ${REQUESTABLE_SETTING_KEYS.join(', ')}`, data: { field: 'key', expected: REQUESTABLE_SETTING_KEYS } };
  }
  if (value === undefined) return { ok: false, message: 'a change needs a value', data: { field: 'value' } };
  const normalized = normalize({ [key]: value } as Partial<Settings>);
  if (!normalized.ok) return { ok: false, message: normalized.message, data: { field: 'value', setting: normalized.field } };
  const proposed = normalized.patch[key] ?? null;
  const previous = effectiveSetting(settings, key);
  if (sameSetting(proposed, previous)) return { ok: false, message: `${key} is already ${JSON.stringify(previous)}`, data: { field: 'value', key } };
  if (open.some(card => card.kind === 'change' && card.key === key)) return { ok: false, message: `a card asking about ${key} is already open in this thread`, data: { field: 'key', key } };
  return {
    ok: true, reason, setting: { kind: 'change', key, value: proposed, previous, ...REQUESTABLE_SETTINGS[key] },
    // Applied is never an answer: the core says it when the value moves.
    options: [{ id: 'refuse', label: 'Refuse' }],
  };
}

/**
 * The answer a change card settles with once the settings changed, or null
 * while its setting still holds the value it was asked from.
 */
export function settledSetting(setting: SettingAsk, settings: Settings): QuestionAnswer | null {
  if (setting.kind !== 'change') return null;
  const now = effectiveSetting(settings, setting.key);
  if (sameSetting(now, setting.previous)) return null;
  return { optionIds: [sameSetting(now, setting.value) ? 'applied' : 'changed'], value: now };
}

/** What the agent reads once its card settles, under the quoted reason. */
export function settingAnswerText(setting: SettingAsk, answer: QuestionAnswer): string {
  const outcome = answer.optionIds[0];
  if (setting.kind === 'open') {
    const where = setting.section === null ? setting.page : `${setting.page}#${setting.section}`;
    return outcome === 'open' ? `opened: the user opened Settings at ${where}` : `dismissed: the user did not open Settings at ${where}`;
  }
  const json = (value: unknown): string => JSON.stringify(value ?? null);
  if (outcome === 'applied') return `applied: ${setting.key} is now ${json(answer.value)}`;
  if (outcome === 'changed') return `changed: the user set ${setting.key} to ${json(answer.value)}, not ${json(setting.value)}`;
  return `refused: ${setting.key} stays ${json(setting.previous)}`;
}
