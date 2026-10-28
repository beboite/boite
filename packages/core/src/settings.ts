import { checkSettingsPatch, followedPatch, keepLaterFavorites, readSettings, MACHINE_SETTINGS, DEFAULT_THREAD_DONE_RETENTION_DAYS, DEFAULT_THREAD_DELETION_RETENTION_DAYS, subscriptionProxyOf, type AdminPolicy, type Settings, type SubscriptionProxy } from '@boite/contracts';
import type { Core } from './core.ts';
import { writesTitles } from './drivers/index.ts';
import { invalidParams } from './errors.ts';
import { DOUANE_PLUGIN } from './plugins/gateway.ts';
import { announceMachineSetting } from './threads/group-spawn.ts';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_SETTINGS: Settings = {
  threadDoneRetentionDays: DEFAULT_THREAD_DONE_RETENTION_DAYS,
  threadDeletionRetentionDays: DEFAULT_THREAD_DELETION_RETENTION_DAYS,
  worktreeStorage: { mode: 'project', directory: null },
  warmProcessMinutes: 0,
  listenOnLan: false,
  agentCpuCapPercent: 75,
  agentMemoryBudgetPercent: 60,
  threadMemoryCapMb: 0,
  memoryReserveMb: 0,
  memoryProtection: true,
  focusGuard: true,
  muteAgents: true,
  reapOrphans: true,
  autoUpdateHarnesses: false,
};

export class SettingsStore {
  constructor(private readonly core: Core) {}

  /** The settings in force: the user's, with what the admin policy locks read over them. */
  get(): Settings {
    return this.overlay(this.stored());
  }

  /** The user's own choices as saved; a policy that goes away gives them back untouched. */
  stored(): Settings {
    const stored = this.core.journal.getSetting('settings');
    if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS };
    const patch = { ...stored } as Partial<Settings>;
    Reflect.deleteProperty(patch, 'maxConcurrentTurns');
    Reflect.deleteProperty(patch, 'perAccountConcurrency');
    return { ...DEFAULT_SETTINGS, ...patch };
  }

  private overlay(settings: Settings): Settings {
    const locked = this.core.policy.lockedSettings(settings);
    return Object.keys(locked).length === 0 ? settings : { ...settings, ...locked };
  }

  /**
   * The patch as `set` would store it, or the refusal `set` would throw. A
   * settings card checks its proposed value here before it is drawn.
   */
  normalize(patch: Partial<Settings>): Partial<Settings> {
    // Shared with the in-memory client: a pasted address is stored as its bare origin.
    const checked = checkSettingsPatch(patch);
    if (!checked.ok) throw invalidParams(checked.message, { field: checked.field });
    const locked = this.core.policy.settingsRefusal(checked.patch, this.get());
    if (locked !== null) throw locked;
    const storage = checked.patch.worktreeStorage;
    if (storage?.directory) {
      if (!isAbsolute(storage.directory) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\)/i.test(storage.directory))) {
        throw invalidParams('worktreeStorage.directory must be an absolute folder path on this machine', { field: 'worktreeStorage' });
      }
      storage.directory = resolve(storage.directory);
    }
    // Local mode: Douane's kind and the Douane plugin's loopback URLs, whatever the client sent.
    const proxy = checked.patch.subscriptionProxy;
    if (proxy?.mode === 'local') checked.patch.subscriptionProxy = localProxy(proxy, this.core.plugins.gateways.port(DOUANE_PLUGIN));
    const titleModel = checked.patch.titleModel;
    if (titleModel !== undefined && titleModel !== null) {
      const provider = this.core.providers.get(titleModel.providerId);
      if (provider === undefined || !writesTitles(provider.protocol)) {
        throw invalidParams(`titleModel names ${titleModel.providerId}, which is not a loaded provider that writes titles`, {
          field: 'titleModel',
          expected: 'a provider whose summary has titles: true',
        });
      }
    }
    const tracker = checked.patch.goalTracker;
    if (tracker !== undefined && tracker !== null && this.core.providers.get(tracker.providerId) === undefined) {
      throw invalidParams(`goalTracker names ${tracker.providerId}, which is not a loaded provider`, { field: 'goalTracker', expected: this.core.providers.available().map(provider => provider.id) });
    }
    return checked.patch;
  }

  /** The Douane plugin listens on another port: a proxy in local mode follows it. */
  followGateway(port: number): void {
    const proxy = this.get().subscriptionProxy;
    if (proxy?.mode !== 'local') return;
    // The policy holds the proxy off: saving it now would store that over the user's choice.
    if (this.stored().subscriptionProxy?.enabled !== proxy.enabled) return;
    const next = localProxy(proxy, port);
    if (next.baseUrl !== proxy.baseUrl || next.dashboardUrl !== proxy.dashboardUrl || next.kind !== proxy.kind) this.set({ subscriptionProxy: next });
  }

  set(patch: Partial<Settings>, persistPrivate?: () => void): Settings {
    const saved = this.stored();
    const previous = this.overlay(saved);
    const checked = keepLaterFavorites(previous, this.normalize(patch));
    const kept: Settings = { ...saved, ...checked };
    const next = this.overlay(kept);
    this.core.journal.append({ type: 'settings.changed', threadId: null, version: 1, payload: next }, () => {
      // Private credentials share the transaction, never its public event payload.
      persistPrivate?.();
      this.core.journal.setSetting('settings', kept);
    });
    logSettingsChange(this.core, previous, next);
    this.core.scheduler.onSettingsChanged();
    this.core.procs.applySettings(next);
    this.core.bus.emit('settings.updated', next);
    this.core.threads.cards.settleSettings(next);
    for (const key of MACHINE_SETTINGS) {
      if ((previous[key] === true) === (next[key] === true)) continue;
      // Turned off, the bots of the other machines lose this machine's projects before anyone hears of it.
      if (key === 'groupBots') this.core.workforce.groupHost.allowedChanged(next[key] === true);
      announceMachineSetting(this.core, key, next[key] === true);
    }
    if (checked.subscriptionProxy !== undefined) {
      for (const account of this.core.accounts.list()) {
        const provider = this.core.providers.get(account.providerId);
        // Only an account the gateway answered for before or answers for now: a
        // refusal kept on any other one came from its own sign-in, and a proxy
        // that never served it has nothing to say about it.
        if (subscriptionProxyOf(previous, provider) !== null || subscriptionProxyOf(next, provider) !== null) {
          this.core.journal.deleteSetting(`account-auth-rejected:${account.id}`);
          this.core.accounts.check(account.id, true);
        }
      }
    }
    this.core.group.settingsChanged();
    return next;
  }

  /** The admin policy changed what it locks: everything that follows a setting hears of the new value. */
  policyChanged(before: AdminPolicy): void {
    const saved = this.stored();
    const previous = { ...saved, ...this.core.policy.lockedSettings(saved, before) };
    const next = this.get();
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    this.core.scheduler.onSettingsChanged();
    this.core.procs.applySettings(next);
    this.core.bus.emit('settings.updated', next);
    for (const key of MACHINE_SETTINGS) {
      if ((previous[key] === true) === (next[key] === true)) continue;
      if (key === 'groupBots') this.core.workforce.groupHost.allowedChanged(next[key] === true);
      announceMachineSetting(this.core, key, next[key] === true);
    }
    this.core.group.settingsChanged();
  }
}

/** The proxy in local mode as stored: Douane's kind and the plugin's loopback API and dashboard. */
export function localProxy(proxy: SubscriptionProxy, port: number): SubscriptionProxy {
  return { ...proxy, kind: 'douane', mode: 'local', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` };
}

export function registerSettingsMethods(core: Core): void {
  core.router.register('settings.get', () => core.settings.get());
  core.router.register('settings.set', (params) => core.settings.set(params));
  // One read and one write in the same turn of the event loop: no save from another window lands between them.
  core.router.register('settings.follow', (params) => {
    const patch: unknown = params?.patch;
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw invalidParams('patch: expected an object of settings', { field: 'patch' });
    const followed = followedPatch(core.settings.get(), patch);
    return Object.keys(followed).length === 0 ? core.settings.get() : core.settings.set(followed);
  });
  core.router.register('agent.settings', () => ({ app: core.clients.app(), settings: readSettings(core.settings.get(), core.clients.current()) }));
  core.router.register('client.preferences', (params, ctx) => {
    core.clients.report(ctx.connection, params);
    return { ok: true, desktop: core.clients.desktopExperiments() } as const;
  });
  core.router.register('settings.request', (params) => core.threads.cards.requestSetting(params));
}

/**
 * Which settings changed, by key. A boolean or a number keeps its new value,
 * since it explains behavior and holds nothing personal; anything else (a
 * path, an address, a model, a list) is named only.
 */
function logSettingsChange(core: Core, previous: Settings, next: Settings): void {
  const changed = (Object.keys(next) as (keyof Settings)[]).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  if (changed.length === 0) return;
  const data: Record<string, string | number | boolean | null> = { keys: changed.join(',').slice(0, 300) };
  for (const key of changed.slice(0, 15)) {
    const value = next[key];
    if (typeof value === 'boolean' || typeof value === 'number') data[String(key).slice(0, 40)] = value;
  }
  core.logs.info(`Settings changed: ${changed.join(', ')}`, { source: 'settings', event: 'settings.changed', data });
}
