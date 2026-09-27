import {
  KEYBINDING_COMMANDS,
  RpcErrorCode,
  type Account,
  type BrainStatus,
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
 * What moves is how the user works: the limits, the process guards, the agent
 * updates, the keybindings file and the brain's switches. What stays is what
 * belongs to the machine: its network face (LAN, public URL, browser origins),
 * its brain folder, and above all its providers. A login is a token, and a
 * token never crosses machines here: the report names every provider signed in
 * on the source and not on the target, so the user signs in there once.
 */

/** The settings that describe the user, not the machine they sit on. */
export const PORTABLE_SETTINGS = [
  'maxConcurrentTurns',
  'perAccountConcurrency',
  'warmProcessMinutes',
  'agentCpuCapPercent',
  'threadMemoryCapMb',
  'focusGuard',
  'muteAgents',
  'reapOrphans',
  'autoUpdateHarnesses',
  'asyncQuestions'
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
  /** The target's keybindings file after the copy. */
  keybindings: Keybindings;
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

/** A core that predates a method has nothing of it to copy. */
async function optional<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return null;
    throw error;
  }
}

export async function syncSettings(source: SyncEnd, target: SyncEnd): Promise<SyncReport> {
  const [fromSettings, toSettings] = await Promise.all([
    source.client.call('settings.get', {}),
    target.client.call('settings.get', {})
  ]);
  const patch = portable(fromSettings);
  const changed = Object.entries(patch).filter(([key, value]) => toSettings[key as keyof Settings] !== value).length;
  const settings = await target.client.call('settings.set', patch);

  // The file only names what differs from the defaults: the target starts from
  // them too, then takes each entry of the source, an unbound command included.
  const fromKeys = await source.client.call('keybindings.get', {});
  let keybindings = await target.client.call('keybindings.reset', {});
  for (const command of KEYBINDING_COMMANDS) {
    const chord = fromKeys.bindings[command];
    if (chord !== undefined) keybindings = await target.client.call('keybindings.set', { command, chord });
  }

  let brain: SyncReport['brain'] = 'none';
  const [fromBrain, toBrain] = await Promise.all([
    optional<BrainStatus>(source.client.call('brain.status', {})),
    optional<BrainStatus>(target.client.call('brain.status', {}))
  ]);
  if (fromBrain?.config.path) {
    if (toBrain?.config.path) {
      // The folder is the target's own; only the switches come across.
      await target.client.call('brain.configure', {
        ...toBrain.config,
        ...(fromBrain.config.autoPull ? { autoPull: fromBrain.config.autoPull } : {}),
        ...(fromBrain.config.globalInstructions !== undefined ? { globalInstructions: fromBrain.config.globalInstructions } : {}),
        ...(fromBrain.config.boiteGuide !== undefined ? { boiteGuide: fromBrain.config.boiteGuide } : {})
      });
      brain = 'copied';
    } else if (toBrain) brain = 'absent';
  }

  return { settings, changed, keybindings, brain, providers: providersToConnect(source, target) };
}
