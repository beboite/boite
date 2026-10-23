import { errorText } from './errors';
import {
  KEYBINDING_COMMANDS,
  SYNCED_BRAIN,
  SYNCED_DEFAULTS,
  SYNCED_SETTINGS,
  RpcErrorCode,
  type BrainStatus,
  type KeybindingCommand,
  type Keybindings,
  type Settings
} from '@boite/contracts';
import { RpcFailure, type Client } from './client';

/**
 * Copying the group's settings home onto a machine that follows it, from a
 * window that owns both. The client does it with the calls each core already
 * answers, so a core needs nothing new and an older one simply lacks what it
 * cannot take.
 *
 * What follows is `SYNCED_SETTINGS`, the keybindings and the brain switches;
 * everything else stays on its own machine. What the target changed for
 * itself (`Settings.syncOverrides`) is skipped. Login tokens never cross
 * machines: a sign-in stays where it was made.
 */

/** One machine as the sync sees it. */
export interface SyncEnd {
  client: Client;
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
}

/** A synced setting's value in effect: what the core says, or its default when the core leaves it out. */
function effective(settings: Settings, key: (typeof SYNCED_SETTINGS)[number]): unknown {
  return settings[key] === undefined ? SYNCED_DEFAULTS[key] : settings[key];
}

/** The synced settings in effect on the home, but for those the target keeps. */
export function portable(settings: Settings, kept: ReadonlySet<string> = new Set()): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const key of SYNCED_SETTINGS) {
    if (!kept.has(key)) (patch as Record<string, unknown>)[key] = effective(settings, key);
  }
  return patch;
}

/** The three parts of a copy, in the order they reach the target. */
export type SyncStage = 'settings' | 'keybindings' | 'brain';

/** A copy that stopped partway: the stages before `stage` are on the target and stay there. */
export class SyncFailure extends Error {
  constructor(readonly stage: SyncStage, error: unknown) {
    super(errorText(error), { cause: error });
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
async function copyKeybindings(source: Client, target: Client, kept: ReadonlySet<string>, signal?: AbortSignal): Promise<Keybindings | null> {
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
      if (from.bindings[command] === to.bindings[command] || kept.has(`keybinding:${command}`)) continue;
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
  let kept: ReadonlySet<string> = new Set();
  const { settings, changed } = await stage('settings', async () => {
    const [fromSettings, toSettings] = await Promise.all([
      source.client.call('settings.get', {}),
      target.client.call('settings.get', {})
    ]);
    kept = new Set(toSettings.syncOverrides ?? []);
    // `autoCompact` is an object: two equal ones are never the same reference.
    const differs = (settings: Settings) => Object.entries(portable(fromSettings, kept))
      .filter(([key, value]) => JSON.stringify(effective(settings, key as (typeof SYNCED_SETTINGS)[number])) !== JSON.stringify(value));
    const changed = differs(toSettings).length;
    signal?.throwIfAborted();
    if (!changed) return { settings: toSettings, changed };
    // The target leaves out what it keeps at the moment it writes: a save from another window meanwhile stays its own.
    const patch = Object.fromEntries(differs(toSettings)) as Partial<Settings>;
    const written = await optional(target.client.call('settings.follow', { patch }));
    return { settings: written ?? await target.client.call('settings.set', patch), changed };
  });

  // What the target keeps, read again before each later part: a chord or a switch kept there during the copy stays its own.
  const keptNow = async () => new Set((await target.client.call('settings.get', {})).syncOverrides ?? []);
  signal?.throwIfAborted();
  const keybindings = await stage('keybindings', async () => copyKeybindings(source.client, target.client, await keptNow(), signal));

  const brain = await stage('brain', async (): Promise<SyncReport['brain']> => {
    const [fromBrain, toBrain] = await Promise.all([
      optional<BrainStatus>(source.client.call('brain.status', {})),
      optional<BrainStatus>(target.client.call('brain.status', {}))
    ]);
    kept = await keptNow();
    if (!fromBrain?.config.path) return 'none';
    if (!toBrain?.config.path) return toBrain ? 'absent' : 'none';
    // The folder is the target's own; only the switches it does not keep come across.
    const follows = (name: (typeof SYNCED_BRAIN)[number]) => !kept.has(`brain:${name}`);
    const config = {
      ...toBrain.config,
      ...(follows('enabled') ? { enabled: fromBrain.config.enabled } : {}),
      ...(follows('autoPull') && (fromBrain.config.autoPull !== undefined || toBrain.config.autoPull !== undefined)
        ? { autoPull: fromBrain.config.autoPull ?? { onStartup: false, intervalMinutes: 0 } } : {}),
      ...(follows('globalInstructions') && fromBrain.config.globalInstructions !== undefined ? { globalInstructions: fromBrain.config.globalInstructions } : {}),
      ...(follows('boiteGuide') && fromBrain.config.boiteGuide !== undefined ? { boiteGuide: fromBrain.config.boiteGuide } : {})
    };
    signal?.throwIfAborted();
    if (JSON.stringify(config) !== JSON.stringify(toBrain.config)) await target.client.call('brain.configure', config);
    return 'copied';
  });

  return { settings, changed, keybindings, brain };
}
