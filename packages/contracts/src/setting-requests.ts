import type { QuestionAnswer, QuestionOption, Settings, ThreadId } from './index.ts';

/*
 * An agent helping the user set Boite up: it reads the settings, then asks for
 * a change with a card in the conversation (`boite settings request`) or
 * points at a Settings page (`boite settings open`). The card never writes
 * anything itself. Apply calls `settings.set`, which only the owner reaches,
 * and the core settles the card when the value it asked about changes, from
 * the card or from the page. An experiment is a device's own switch: the app
 * reports which are on (`client.preferences`), the card flips it there, and
 * the core settles the card on the next report. See docs/cli.md.
 */

/**
 * The experiments this build ships, in the order Settings lists them. Each
 * device turns them on for itself (`packages/ui/src/lib/experiments.ts`).
 */
export const EXPERIMENT_IDS = ['theme-grain', 'session-import', 'prompt-cache', 'resident-agents', 'whip', 'recording-indicators', 'contacts', 'pinned-quotas', 'auto-goal', 'teams'] as const;
export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

export function isExperimentId(id: unknown): id is ExperimentId {
  return typeof id === 'string' && (EXPERIMENT_IDS as readonly string[]).includes(id);
}

/** The languages the app speaks (`docs/language.md`). */
export const APP_LANGUAGES = ['en', 'fr'] as const;
export type AppLanguage = (typeof APP_LANGUAGES)[number];

/** A setting key as an agent names it for an experiment: `experiment.resident-agents`. */
export type ExperimentSettingKey = `experiment.${ExperimentId}`;

/**
 * What an app tells its core about itself, after each hello and on every
 * change (`client.preferences`), so an agent reads the screen the user reads:
 * the language, the experiments on, and the names it gives settings.
 */
export interface ClientPreferences {
  /**
   * This app's own id, random and kept on the device (`boite.appId`), the same
   * across reconnects: a flip made while offline still reads as a flip.
   */
  app: string;
  language: AppLanguage;
  experiments: ExperimentId[];
  /**
   * The names the app shows, in its language: a requestable key, an
   * `experiment.<id>`, or a Settings page id. A key the app leaves out reads
   * as the key itself.
   */
  labels: Record<string, string>;
}

export const CLIENT_LABELS_MAX = 120;
export const CLIENT_APP_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const CLIENT_LABEL_CHARS = 120;

/** A report checked, or why it is refused. Labels lose control characters and keep the known keys only. */
export function checkClientPreferences(params: unknown): { ok: true; preferences: ClientPreferences } | { ok: false; message: string; field: string } {
  const given = (params ?? {}) as Partial<Record<keyof ClientPreferences, unknown>>;
  if (typeof given.app !== 'string' || !CLIENT_APP_PATTERN.test(given.app)) return { ok: false, message: 'app must be 8 to 64 letters, digits, dashes or underscores', field: 'app' };
  if (!(APP_LANGUAGES as readonly unknown[]).includes(given.language)) return { ok: false, message: `language must be one of ${APP_LANGUAGES.join(', ')}`, field: 'language' };
  if (!Array.isArray(given.experiments) || given.experiments.length > EXPERIMENT_IDS.length * 2) return { ok: false, message: 'experiments must be a list of experiment ids', field: 'experiments' };
  // A newer app may ship an experiment this core does not know: it is left out, not refused.
  const experiments = EXPERIMENT_IDS.filter(id => (given.experiments as unknown[]).includes(id));
  const raw = given.labels ?? {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > CLIENT_LABELS_MAX) return { ok: false, message: `labels must map at most ${CLIENT_LABELS_MAX} keys to names`, field: 'labels' };
  const known = new Set<string>([...REQUESTABLE_SETTING_KEYS, ...EXPERIMENT_IDS.map(id => `experiment.${id}`), ...SETTINGS_PAGES]);
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(key) || typeof value !== 'string') continue;
    // A label lands inside a line the agent reads.
    const clean = value.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, ' ').trim().slice(0, CLIENT_LABEL_CHARS);
    if (clean.length > 0) labels[key] = clean;
  }
  return { ok: true, preferences: { app: given.app, language: given.language as AppLanguage, experiments, labels } };
}

export function sameClientPreferences(a: ClientPreferences | null, b: ClientPreferences | null): boolean {
  return canonical(a) === canonical(b);
}

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
  toolSummaries: { page: 'general', section: 'conversations', sensitive: false },
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
  autoUpdateHarnesses: { page: 'accounts', section: 'agent-updates', sensitive: false },
  autoInstallUpdates: { page: 'machines', section: 'updates', sensitive: false },
  listenOnLan: { page: 'advanced', section: 'phone', sensitive: true },
  publicUrl: { page: 'advanced', section: 'phone', sensitive: true },
  browserOrigins: { page: 'advanced', section: 'origins', sensitive: true },
  warmProcessMinutes: { page: 'advanced', section: 'execution', sensitive: false },
  autoCompact: { page: 'advanced', section: 'auto-compact', sensitive: false },
  compactionByType: { page: 'advanced', section: 'auto-compact', sensitive: false },
  compactionSummary: { page: 'advanced', section: 'auto-compact', sensitive: false },
  autoResumeLimitedThreads: { page: 'limits', section: 'limit-resume', sensitive: false },
  backgroundCompaction: { page: 'experiments', section: 'background-compaction', sensitive: false },
  deviceStream: { page: 'experiments', section: 'device-stream', sensitive: false },
  groupThreads: { page: 'machines', section: 'machines', sensitive: false },
  groupBots: { page: 'machines', section: 'machines', sensitive: false },
} as const satisfies Partial<Record<keyof Settings, SettingPlace>>;

export type RequestableSetting = keyof typeof REQUESTABLE_SETTINGS;
export const REQUESTABLE_SETTING_KEYS = Object.keys(REQUESTABLE_SETTINGS) as RequestableSetting[];

export function isRequestableSetting(key: unknown): key is RequestableSetting {
  return typeof key === 'string' && Object.hasOwn(REQUESTABLE_SETTINGS, key);
}

/**
 * The settings a card may ask about on another machine of the group
 * (`boite settings request <key> <value> --machine <name>`): what that machine
 * lets the others do there. Apply writes it on that machine.
 */
export const MACHINE_SETTINGS = ['groupThreads', 'groupBots'] as const satisfies readonly RequestableSetting[];
export type MachineSetting = (typeof MACHINE_SETTINGS)[number];

export function isMachineSetting(key: unknown): key is MachineSetting {
  return typeof key === 'string' && (MACHINE_SETTINGS as readonly string[]).includes(key);
}

/** The other machine of the group a card is about: its core id, and its name when the card was asked. */
export interface SettingMachine {
  coreId: string;
  name: string;
}

export function isSettingsPage(page: unknown): page is SettingsPage {
  return typeof page === 'string' && (SETTINGS_PAGES as readonly string[]).includes(page);
}

/** A section anchor as the app writes them: lowercase words joined by dashes. */
export const SETTINGS_SECTION_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A key a card may change: a core setting, or an experiment of the user's app. */
export type RequestableKey = RequestableSetting | ExperimentSettingKey;

export function experimentOf(key: string): ExperimentId | null {
  const id = key.startsWith('experiment.') ? key.slice('experiment.'.length) : null;
  return isExperimentId(id) ? id : null;
}

/**
 * True for any `experiment.<id>` key, shipped or since graduated: a card
 * asked about a switch this build no longer lists is still a device's switch,
 * which a core setting never settles and `settings.set` never writes.
 */
export function isExperimentKey(key: string): boolean {
  return key.startsWith('experiment.');
}

/** One readable setting, as `agent.settings` lists it. */
export interface SettingReading extends SettingPlace {
  key: RequestableKey;
  /** The value now; null where the core keeps none and uses its default. */
  value: unknown;
  /** Its name in the user's app, in the app's language, when the app said it. */
  label?: string;
}

/** `agent.settings`: the app the user last used, then every readable setting. */
export interface SettingsReading {
  /** The app the user last used: its language and the computer or phone it runs on. Null before any app reported. */
  app: { language: AppLanguage; device: string | null; client: 'shell' | 'pwa' | null } | null;
  settings: SettingReading[];
}

/**
 * What a settings card carries, beside the question's text, which is the
 * agent's reason. `change` proposes a value for one key; `open` only points at
 * a page, for what is not a single value: a provider login, a pairing.
 */
export type SettingAsk =
  | {
      kind: 'change';
      /** A core setting, or `experiment.<id>`: a switch of the app the user last used. */
      key: RequestableKey;
      /** The proposed value, as `settings.set` would store it. */
      value: unknown;
      /** The value when the agent asked, null when unset. The card settles when the setting leaves it. */
      previous: unknown;
      page: SettingsPage;
      section: string;
      sensitive: boolean;
      /** An experiment's card: the app whose switch it was asked from (`ClientPreferences.app`). */
      app?: string;
      /** A card about another machine of the group: Apply writes it there (`MACHINE_SETTINGS`). */
      machine?: SettingMachine;
    }
  | { kind: 'open'; page: SettingsPage; section: string | null };

/**
 * How a settings card ended, the one option id its answer carries. Only
 * `refuse` and `open` are options the user answers with; the core writes
 * `applied` and `changed` itself when the setting changes.
 */
export type SettingOutcome = 'applied' | 'changed' | 'refuse' | 'open';

export const SETTING_REASON_MAX = 500;

/**
 * Params of `settings.request`: a change of one key, or a page to open.
 * `machine` names another machine of the group, by its name or a core id
 * prefix, for a key of `MACHINE_SETTINGS`.
 */
export type SettingRequestParams = { threadId: ThreadId; reason: string } & (
  | { key: string; value: unknown; machine?: string; page?: never; section?: never }
  | { page: string; section?: string | null; key?: never; value?: never; machine?: never }
);

/** What a missing key means, for the keys the core's defaults leave out. */
const MISSING: Partial<Record<RequestableSetting, unknown>> = {
  asyncQuestions: true,
  autoInstallUpdates: false,
  autoResumeLimitedThreads: false,
  backgroundCompaction: false,
  deviceStream: false,
  groupThreads: false,
  groupBots: false,
  shortAnswers: true,
  toolSummaries: false,
  titleModel: null,
  autoCompact: null,
  compactionByType: {},
  compactionSummary: null,
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

/** A key's value in effect: a core setting, or whether the app has the experiment on; null when no app reported. */
export function currentSetting(key: RequestableKey, settings: Settings, client: ClientPreferences | null): unknown {
  const experiment = experimentOf(key);
  if (experiment === null) return effectiveSetting(settings, key as RequestableSetting);
  return client === null ? null : client.experiments.includes(experiment);
}

function experimentPlace(id: ExperimentId): SettingPlace {
  return { page: 'experiments', section: id, sensitive: false };
}

/** Every readable setting, an app's experiments after the core's settings once an app reported them. */
export function readSettings(settings: Settings, client: ClientPreferences | null = null): SettingReading[] {
  const labelled = (key: RequestableKey): { label?: string } => (client?.labels[key] === undefined ? {} : { label: client.labels[key] });
  const core: SettingReading[] = REQUESTABLE_SETTING_KEYS.map(key => ({ key, value: effectiveSetting(settings, key), ...REQUESTABLE_SETTINGS[key], ...labelled(key) }));
  if (client === null) return core;
  return [...core, ...EXPERIMENT_IDS.map(id => {
    const key: ExperimentSettingKey = `experiment.${id}`;
    return { key, value: client.experiments.includes(id), ...experimentPlace(id), ...labelled(key) };
  })];
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
 * the thread already has open, one per key and machine at most. For a card
 * about another machine, `machine` names it and `settings` holds the value
 * that machine reported for the key.
 */
export function checkSettingRequest(params: SettingRequestParams, settings: Settings, normalize: SettingNormalizer, open: readonly SettingAsk[], client: ClientPreferences | null = null, machine: SettingMachine | null = null): SettingRequestCheck {
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
  if (machine !== null && !isMachineSetting(key)) {
    return { ok: false, message: `${String(key)} is this machine's own; a card for another machine asks about ${MACHINE_SETTINGS.join(', ')}`, data: { field: 'key', expected: MACHINE_SETTINGS } };
  }
  const experiment = typeof key === 'string' ? experimentOf(key) : null;
  if (!isRequestableSetting(key) && experiment === null) {
    const keys = [...REQUESTABLE_SETTING_KEYS, ...EXPERIMENT_IDS.map(id => `experiment.${id}`)];
    return { ok: false, message: `${String(key)} is not a setting an agent may ask about; the keys are ${keys.join(', ')}`, data: { field: 'key', expected: keys } };
  }
  if (value === undefined) return { ok: false, message: 'a change needs a value', data: { field: 'value' } };
  let proposed: unknown;
  let place: SettingPlace;
  if (experiment !== null) {
    if (typeof value !== 'boolean') return { ok: false, message: 'an experiment is true or false', data: { field: 'value', expected: 'true or false' } };
    if (client === null) return { ok: false, message: 'no Boite app has reported its experiments yet; ask the user to open the app', data: { field: 'key', key } };
    proposed = value;
    place = experimentPlace(experiment);
  } else {
    const normalized = normalize({ [key]: value } as Partial<Settings>);
    if (!normalized.ok) return { ok: false, message: normalized.message, data: { field: 'value', setting: normalized.field } };
    proposed = normalized.patch[key as RequestableSetting] ?? null;
    place = REQUESTABLE_SETTINGS[key as RequestableSetting];
  }
  const settingKey = key as RequestableKey;
  const previous = currentSetting(settingKey, settings, client);
  const where = machine === null ? '' : ` on ${machine.name}`;
  if (sameSetting(proposed, previous)) return { ok: false, message: `${key} is already ${JSON.stringify(previous)}${where}`, data: { field: 'value', key } };
  if (open.some(card => card.kind === 'change' && card.key === key && (card.machine?.coreId ?? null) === (machine?.coreId ?? null))) {
    return { ok: false, message: `a card asking about ${key}${where} is already open in this thread`, data: { field: 'key', key } };
  }
  return {
    ok: true, reason,
    setting: { kind: 'change', key: settingKey, value: proposed, previous, ...place, ...(experiment !== null && client !== null ? { app: client.app } : {}), ...(machine === null ? {} : { machine: { ...machine } }) },
    // Applied is never an answer: the core says it when the value moves.
    options: [{ id: 'refuse', label: 'Refuse' }],
  };
}

/**
 * The answer a change card about a core setting settles with once the
 * settings changed, or null while its setting still holds the value it was
 * asked from. An experiment's card never settles here: a core setting moving
 * flips no switch (`settledExperiment`).
 */
export function settledSetting(setting: SettingAsk, settings: Settings): QuestionAnswer | null {
  if (setting.kind !== 'change' || isExperimentKey(setting.key) || setting.machine !== undefined) return null;
  const now = effectiveSetting(settings, setting.key as RequestableSetting);
  if (sameSetting(now, setting.previous)) return null;
  return { optionIds: [sameSetting(now, setting.value) ? 'applied' : 'changed'], value: now };
}

/**
 * The answer a card about another machine settles with once that machine
 * said its setting changed (`value`), or null while it holds the value the
 * card was asked from, or the card is about another machine or key.
 */
export function settledMachineSetting(setting: SettingAsk, coreId: string, key: string, value: unknown): QuestionAnswer | null {
  if (setting.kind !== 'change' || setting.machine?.coreId !== coreId || setting.key !== key) return null;
  if (sameSetting(value, setting.previous)) return null;
  return { optionIds: [sameSetting(value, setting.value) ? 'applied' : 'changed'], value };
}

/**
 * The answer an experiment's card settles with when an app reports, or null.
 * It settles when that app flipped the switch since its last report (`before`,
 * null when the core has none), or when the app it was asked from reports a
 * value other than the one it was asked from: a flip made offline or across a
 * restart. Another app that merely had a different value, a language change
 * or a core setting moving settles nothing.
 */
export function settledExperiment(setting: SettingAsk, report: ClientPreferences, before: readonly ExperimentId[] | null): QuestionAnswer | null {
  if (setting.kind !== 'change') return null;
  const id = experimentOf(setting.key);
  if (id === null) return null;
  const on = report.experiments.includes(id);
  const flipped = before !== null && before.includes(id) !== on;
  const fromAsker = setting.app === report.app && on !== setting.previous;
  if (!flipped && !fromAsker) return null;
  return { optionIds: [on === setting.value ? 'applied' : 'changed'], value: on };
}

/** What the agent reads once its card settles, under the quoted reason. */
export function settingAnswerText(setting: SettingAsk, answer: QuestionAnswer): string {
  const outcome = answer.optionIds[0];
  if (setting.kind === 'open') {
    const where = setting.section === null ? setting.page : `${setting.page}#${setting.section}`;
    return outcome === 'open' ? `opened: the user opened Settings at ${where}` : `dismissed: the user did not open Settings at ${where}`;
  }
  const json = (value: unknown): string => JSON.stringify(value ?? null);
  const where = setting.machine === undefined ? '' : ` on ${setting.machine.name}`;
  if (outcome === 'applied') return `applied: ${setting.key} is now ${json(answer.value)}${where}`;
  if (outcome === 'changed') return `changed: the user set ${setting.key} to ${json(answer.value)}${where}, not ${json(setting.value)}`;
  return `refused: ${setting.key} stays ${json(setting.previous)}${where}`;
}
