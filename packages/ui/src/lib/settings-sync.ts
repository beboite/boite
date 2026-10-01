import {
  KEYBINDING_COMMANDS,
  RpcErrorCode,
  type Account,
  type BrainStatus,
  type KeybindingCommand,
  type Keybindings,
  type ProviderSummary,
  type Settings
} from '@boite/contracts';
import { RpcFailure, type Client } from './client';
import { familyOf, providerRows, type ProviderRow } from './provider-family';
import { connected } from './provider-setup';

/**
 * Copying one machine's settings onto another, from a window that owns both.
 * The client does it with the calls each core already answers, so a core needs
 * nothing new and an older one simply lacks what it cannot take.
 *
 * Deleted-history retention, process guards, question mode, keybindings and
 * brain switches follow the user.
 * Resource limits, process retention, agent updates, storage, network access,
 * the brain folder and providers stay on their owning machine. Login tokens
 * never cross machines here: the report names every provider signed in
 * on the source and not on the target, so the user signs in there once.
 */

/** The settings that describe the user, not the machine they sit on. */
export const PORTABLE_SETTINGS = [
  'threadDeletionRetentionDays',
  'focusGuard',
  'muteAgents',
  'reapOrphans',
  'asyncQuestions',
  'autoCompact'
] as const satisfies readonly (keyof Settings)[];

/** One machine as the sync sees it: its connection and what its store last listed. */
export interface SyncEnd {
  client: Client;
  providers: readonly ProviderSummary[];
  accounts: Account[];
}

export interface SyncReport {
  /** The target's settings after the copy. */
  settings: Settings;
  /** How many portable settings had another value on the target. */
  changed: number;
  /** The target's keybindings file after the copy, null when either core has no keybindings to copy. */
  keybindings: Keybindings | null;
  /** `copied` when both brains are connected, `absent` when only the source has one. */
  brain: 'copied' | 'absent' | 'none';
  /** Providers the user works with on the source and has not signed into on the target. */
  providers: ProviderRow[];
}

/** The portable part of a settings object, without the fields an older core leaves out. */
export function portable(settings: Settings): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of PORTABLE_SETTINGS) {
    if (settings[key] !== undefined) (patch as Record<string, unknown>)[key] = settings[key];
  }
  return patch;
}

/** Families signed in on the source with no signed-in member on the target. */
export function providersToConnect(source: Omit<SyncEnd, 'client'>, target: Omit<SyncEnd, 'client'>): ProviderRow[] {
  const on = (end: Omit<SyncEnd, 'client'>, family: string) =>
    end.providers.some((provider) => familyOf(provider.id) === family && connected(provider, end.accounts));
  return providerRows(source.providers).filter((row) => on(source, row.id) && !on(target, row.id));
}

/** The three parts of a copy, in the order they reach the target. */
export type SyncStage = 'settings' | 'keybindings' | 'brain';

/** A copy that stopped partway: the stages before `stage` are on the target and stay there. */
export class SyncFailure extends Error {
  constructor(readonly stage: SyncStage, error: unknown) {
    super(error instanceof Error ? error.message : String(error), { cause: error });
  }
}

const unknownMethod = (error: unknown): boolean => error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound;

/** A core that predates a method has nothing of it to copy. */
async function optional<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (unknownMethod(error)) return null;
    throw error;
  }
}

async function stage<T>(name: SyncStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new SyncFailure(name, error);
  }
}

/**
 * The file only names what differs from the defaults, so the target takes each
 * command where the two files disagree: the source's chord, its unbinding, or
 * back to the default where the source names nothing. One entry at a time, and
 * nothing the target names is dropped before its replacement is in: a call that
 * fails puts every entry already changed back as it was.
 */
async function copyKeybindings(source: Client, target: Client, signal?: AbortSignal): Promise<Keybindings | null> {
  const [from, to] = await Promise.all([
    optional(source.call('keybindings.get', {})),
    optional(target.call('keybindings.get', {}))
  ]);
  if (from === null || to === null) return null;
  const write = (command: KeybindingCommand, chord: string | null | undefined) =>
    chord === undefined ? target.call('keybindings.reset', { command }) : target.call('keybindings.set', { command, chord });
  const changed: KeybindingCommand[] = [];
  let result = to;
  try {
    for (const command of KEYBINDING_COMMANDS) {
      if (from.bindings[command] === to.bindings[command]) continue;
      signal?.throwIfAborted();
      changed.push(command);
      result = await write(command, from.bindings[command]);
      signal?.throwIfAborted();
    }
  } catch (error) {
    // Cancellation stops forward copies, but entries already written still need restoring.
    for (const command of changed.reverse()) await write(command, to.bindings[command]).catch(() => undefined);
    // A target that reads its file but cannot write an entry has kept its own.
    if (unknownMethod(error)) return null;
    throw error;
  }
  return result;
}

/** Settings, then keybindings, then the brain: a failure names its stage in a SyncFailure. */
export async function syncSettings(source: SyncEnd, target: SyncEnd, signal?: AbortSignal): Promise<SyncReport> {
  const { settings, changed } = await stage('settings', async () => {
    const [fromSettings, toSettings] = await Promise.all([
      source.client.call('settings.get', {}),
      target.client.call('settings.get', {})
    ]);
    const patch = portable(fromSettings);
    const changed = Object.entries(patch).filter(([key, value]) => toSettings[key as keyof Settings] !== value).length;
    signal?.throwIfAborted();
    return { settings: changed ? await target.client.call('settings.set', patch) : toSettings, changed };
  });

  signal?.throwIfAborted();
  const keybindings = await stage('keybindings', () => copyKeybindings(source.client, target.client, signal));

  const brain = await stage('brain', async (): Promise<SyncReport['brain']> => {
    const [fromBrain, toBrain] = await Promise.all([
      optional<BrainStatus>(source.client.call('brain.status', {})),
      optional<BrainStatus>(target.client.call('brain.status', {}))
    ]);
    if (!fromBrain?.config.path) return 'none';
    if (!toBrain?.config.path) return toBrain ? 'absent' : 'none';
    // The folder is the target's own; only the switches come across.
    const config = {
      ...toBrain.config,
      enabled: fromBrain.config.enabled,
      ...(fromBrain.config.autoPull !== undefined || toBrain.config.autoPull !== undefined
        ? { autoPull: fromBrain.config.autoPull ?? { onStartup: false, intervalMinutes: 0 } } : {}),
      ...(fromBrain.config.globalInstructions !== undefined ? { globalInstructions: fromBrain.config.globalInstructions } : {}),
      ...(fromBrain.config.boiteGuide !== undefined ? { boiteGuide: fromBrain.config.boiteGuide } : {})
    };
    signal?.throwIfAborted();
    if (JSON.stringify(config) !== JSON.stringify(toBrain.config)) await target.client.call('brain.configure', config);
    return 'copied';
  });

  return { settings, changed, keybindings, brain, providers: providersToConnect(source, target) };
}
