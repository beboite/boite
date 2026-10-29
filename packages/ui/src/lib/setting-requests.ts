/**
 * What a settings card says: a setting's name, its value as a person reads
 * it, and where it sits in Settings. The card itself is
 * `components/SettingRequestCard.svelte`; the checks it shares with the core
 * are in `packages/contracts/src/setting-requests.ts`, the core's cards in
 * `packages/core/src/threads/cards.ts`.
 */
import { experimentOf, type AutoCompactMoment, type ProviderSummary, type RequestableKey, type RequestableSetting, type SettingAsk, type SettingsPage } from '@boite/contracts';
import { experimentCopy } from './experiment-copy';
import { formatLocale } from './i18n.svelte';
import { fill, strings } from './strings';
import { formatTokens } from './format';

const UNITS: Partial<Record<RequestableSetting, { unit: string; display: 'short' | 'long' }>> = {
  agentCpuCapPercent: { unit: 'percent', display: 'short' },
  agentMemoryBudgetPercent: { unit: 'percent', display: 'short' },
  threadMemoryCapMb: { unit: 'megabyte', display: 'short' },
  memoryReserveMb: { unit: 'megabyte', display: 'short' },
  warmProcessMinutes: { unit: 'minute', display: 'short' },
  threadDoneRetentionDays: { unit: 'day', display: 'long' },
  threadDeletionRetentionDays: { unit: 'day', display: 'long' },
};

/**
 * The experiments that left the Experiments page, for a card asked about one
 * before: the name the user knows it by now, and whether a switch is left.
 */
function graduated(key: string): { title: string; switched: boolean } | null {
  const id = key.startsWith('experiment.') ? key.slice('experiment.'.length) : null;
  if (id === 'open-chat-links') return { title: strings.features.openChatLinks.title, switched: true };
  if (id === 'preview-comments') return { title: strings.features.previewComments.title, switched: true };
  if (id === 'edge-scrollbars') return { title: strings.features.edgeScrollbars.title, switched: true };
  if (id === 'press-preload') return { title: strings.settingRequest.loadOnPress, switched: false };
  return null;
}

/** What a card about a graduated experiment says instead of offering Apply. */
export function retiredHint(key: string): string {
  return graduated(key)?.switched === false ? strings.settingRequest.retiredAlwaysOn : strings.settingRequest.retired;
}

/** The card's title, in the dock's row and on the card. */
export function settingHeading(setting: SettingAsk): string {
  const words = strings.settingRequest;
  return setting.kind === 'open' ? words.headingOpen : setting.sensitive ? words.headingSensitive : words.heading;
}

export function settingLabel(key: RequestableKey): string {
  const experiment = experimentOf(key);
  if (experiment !== null) return experimentCopy()[experiment].title;
  const former = graduated(key);
  if (former !== null) return former.title;
  return strings.settingRequest.keys[key as RequestableSetting] ?? key;
}

/** What the setting does, as the Settings page explains it; null where the card's name says enough. */
export function settingHint(key: RequestableKey): string | null {
  const experiment = experimentOf(key);
  return experiment === null ? null : experimentCopy()[experiment].hint;
}

/** A value as the card shows it: `60 %`, `On`, `512 MB`, `In D:/worktrees`. */
export function settingValueText(key: RequestableKey, value: unknown, providers: readonly ProviderSummary[] = []): string {
  const words = strings.settingRequest;
  if (value === null || value === undefined) return words.none;
  if (typeof value === 'boolean') return value ? words.on : words.off;
  if (typeof value === 'number') {
    const zero = (words.zero as Partial<Record<RequestableKey, string>>)[key];
    if (value === 0 && zero !== undefined) return zero;
    const unit = UNITS[key as RequestableSetting];
    return new Intl.NumberFormat(formatLocale(), unit ? { style: 'unit', unit: unit.unit, unitDisplay: unit.display } : {}).format(value);
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? words.none : value.map(String).join(', ');
  const object = value as Record<string, unknown>;
  if (key === 'worktreeStorage') {
    const directory = typeof object.directory === 'string' ? object.directory : null;
    return object.mode === 'shared' && directory !== null ? fill(words.worktreeShared, { dir: directory }) : words.worktreeProject;
  }
  if (key === 'titleModel' && typeof object.model === 'string') {
    const provider = providers.find((entry) => entry.id === object.providerId);
    return provider ? `${provider.name} · ${object.model}` : object.model;
  }
  if (key === 'autoCompact') {
    const size = typeof object.tokens === 'number' ? fill(words.compactAt, { tokens: formatTokens(object.tokens) }) : words.compactAny;
    const names: Record<AutoCompactMoment, string> = {
      'turn-end': strings.settings.autoCompactTurnEnd,
      background: strings.settings.autoCompactBackground,
      'cache-expiry': strings.settings.autoCompactCacheExpiry,
    };
    const moments = Array.isArray(object.moments) ? (object.moments as AutoCompactMoment[]).map((moment) => names[moment] ?? moment) : [];
    return [size, ...moments].join(' · ');
  }
  return JSON.stringify(value);
}

export function settingsPageLabel(page: SettingsPage): string {
  const tabs = strings.settings.tabs;
  const labels: Record<SettingsPage, string> = {
    general: tabs.general,
    appearance: tabs.appearance,
    keyboard: tabs.keyboard,
    voice: strings.speech.heading,
    accounts: tabs.accounts,
    plugins: tabs.plugins,
    brain: strings.brain.heading,
    usage: tabs.usage,
    limits: strings.usage.limits,
    'task-manager': strings.taskManager.title,
    resources: tabs.resources,
    machines: tabs.machines,
    advanced: tabs.advanced,
    experiments: tabs.experiments,
  };
  return labels[page];
}

/** A card's name on its page, when the app names it; a provider's card by the provider's name. */
export function settingsSectionLabel(section: string, providers: readonly ProviderSummary[] = []): string | null {
  if (section.startsWith('provider-')) return providers.find((provider) => provider.id === section.slice('provider-'.length))?.name ?? null;
  const settings = strings.settings;
  const labels: Record<string, string> = {
    conversations: settings.conversations,
    archived: settings.archived.heading,
    worktrees: settings.worktrees.heading,
    app: settings.app,
    privacy: strings.telemetry.heading,
    theme: settings.display,
    reading: settings.reading,
    workspace: settings.workspace,
    buttons: strings.controls.heading,
    'brain-folder': strings.brain.folder,
    hooks: strings.hooks.heading,
    quiet: strings.protection.quiet,
    limits: strings.protection.limits,
    tasks: strings.protection.tasks,
    machines: strings.machines.heading,
    updates: strings.appUpdate.updates,
    'agent-updates': strings.harnessUpdates.heading,
    phone: strings.phone.heading,
    execution: settings.execution,
    origins: strings.machines.browserOrigins,
    'auto-compact': settings.autoCompact,
    'device-stream': settings.deviceStream,
    'background-compaction': settings.backgroundCompaction,
  };
  return labels[section] ?? null;
}

/** Pages a paired device's Settings leaves out: `OWNER_TABS` in `SettingsShell.svelte`. */
const OWNER_PAGES: readonly SettingsPage[] = ['accounts', 'plugins', 'resources', 'brain'];
/** Cards of the shared pages that only the owner's Settings draws there. */
const OWNER_SECTIONS: readonly string[] = ['worktrees', 'privacy', 'execution', 'origins', 'auto-compact', 'device-stream', 'background-compaction'];
/**
 * What a phone browser's Settings (`MobileSettings.svelte`) draws: the pages
 * it opens whole, then the cards it has of the others. Keep it in step with
 * that component's `page`.
 */
const PHONE_PAGES: readonly SettingsPage[] = ['appearance', 'voice', 'usage', 'limits', 'task-manager', 'experiments', 'brain'];
const PHONE_CARDS: Partial<Record<SettingsPage, readonly string[]>> = {
  resources: ['quiet', 'limits', 'tasks'],
  machines: ['machines', 'group'],
  general: ['archived', 'worktrees'],
  advanced: ['auto-compact'],
};

/**
 * Whether this client's Settings has the card a settings card points at. A
 * button that would land on Home instead is not offered.
 */
export function settingsReachable(setting: SettingAsk, client: { owner: boolean; phone: boolean }): boolean {
  const section = setting.section;
  if (!client.owner && (OWNER_PAGES.includes(setting.page) || (section !== null && OWNER_SECTIONS.includes(section)))) return false;
  if (!client.phone || PHONE_PAGES.includes(setting.page)) return true;
  const cards = PHONE_CARDS[setting.page];
  if (cards === undefined) return false;
  // Resources and Machines open as pages of their own; General and Advanced only through one of their cards.
  return section === null ? setting.page === 'resources' || setting.page === 'machines' : cards.includes(section);
}

/** `Resources › Limits`, the trail under a card. */
export function settingPlaceText(setting: SettingAsk, providers: readonly ProviderSummary[] = []): string {
  const section = setting.section === null ? null : settingsSectionLabel(setting.section, providers);
  return [settingsPageLabel(setting.page), section].filter((part): part is string => part !== null).join(' › ');
}
