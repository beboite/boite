import type { BrainConfig } from './brain';
import { KEYBINDING_COMMANDS, type KeybindingCommand } from './keybindings';
import { DEFAULT_THREAD_DELETION_RETENTION_DAYS, DEFAULT_THREAD_DONE_RETENTION_DAYS, type Settings } from './settings';

/**
 * What a machine takes from its group's settings home (`Group.settingsHome`):
 * the settings that describe the user, not the machine they sit on. Resource
 * limits, process retention, agent updates, storage, network access, the brain
 * folder and providers stay on their own machine. A client that owns both
 * machines makes the copy; neither core depends on it.
 */
export const SYNCED_SETTINGS = [
  'threadDeletionRetentionDays',
  'threadDoneRetentionDays',
  'focusGuard',
  'muteAgents',
  'reapOrphans',
  'asyncQuestions',
  'shortAnswers',
  'toolSummaries',
  'autoCompact',
  'compactionByType',
  'compactionSummary',
  'cacheKeepalive',
  // How the user wants Boite kept current, not what one machine can do: a
  // server as default machine carries it to every desktop of the group.
  'autoInstallUpdates'
] as const satisfies readonly (keyof Settings)[];

export type SyncedSetting = (typeof SYNCED_SETTINGS)[number];

/**
 * What each synced setting is when a core leaves it out: a default never
 * written, or a setting older than that core. The copy sends these too, so a
 * follower that gives a setting back takes the home's value, implicit or not.
 */
export const SYNCED_DEFAULTS: { [K in SyncedSetting]-?: Exclude<Settings[K], undefined> } = {
  threadDeletionRetentionDays: DEFAULT_THREAD_DELETION_RETENTION_DAYS,
  threadDoneRetentionDays: DEFAULT_THREAD_DONE_RETENTION_DAYS,
  focusGuard: true,
  muteAgents: true,
  reapOrphans: true,
  asyncQuestions: true,
  shortAnswers: true,
  toolSummaries: false,
  autoCompact: null,
  compactionByType: {},
  compactionSummary: null,
  cacheKeepalive: null,
  autoInstallUpdates: false
};

/** The brain switches that follow. The folder is each machine's own. */
export const SYNCED_BRAIN = ['enabled', 'autoPull', 'globalInstructions', 'boiteGuide'] as const satisfies readonly (keyof BrainConfig)[];

export type SyncedBrainSwitch = (typeof SYNCED_BRAIN)[number];

/**
 * One thing a following machine keeps for itself (`Settings.syncOverrides`):
 * a synced setting by its key, a command's chord as `keybinding:<command>`,
 * a brain switch as `brain:<switch>`.
 */
export type SyncKey = SyncedSetting | `keybinding:${KeybindingCommand}` | `brain:${SyncedBrainSwitch}`;

export const SYNC_KEYS: readonly SyncKey[] = [
  ...SYNCED_SETTINGS,
  ...KEYBINDING_COMMANDS.map((command) => `keybinding:${command}` as const),
  ...SYNCED_BRAIN.map((name) => `brain:${name}` as const)
];

const KNOWN = new Set<string>(SYNC_KEYS);

export function isSyncKey(value: unknown): value is SyncKey {
  return typeof value === 'string' && KNOWN.has(value);
}

/** What of `patch` a follower takes: the synced settings it does not keep for itself. */
export function followedPatch(settings: Settings, patch: unknown): Partial<Settings> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return {};
  const kept = new Set(settings.syncOverrides ?? []);
  return Object.fromEntries(Object.entries(patch).filter(([key]) => (SYNCED_SETTINGS as readonly string[]).includes(key) && !kept.has(key))) as Partial<Settings>;
}

/** Entries one machine may keep: room for every key a later version adds. */
export const SYNC_OVERRIDES_MAX = 256;

/**
 * A key a later version may name: a setting, `keybinding:` or `brain:` and a
 * name. An older core stores it unread rather than refusing a newer client.
 */
export const SYNC_KEY_PATTERN = /^(?:keybinding:|brain:)?[A-Za-z][\w.-]{0,79}$/;
