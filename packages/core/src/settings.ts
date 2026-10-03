import { checkSettingsPatch, DEFAULT_THREAD_DELETION_RETENTION_DAYS, type Settings } from '@boite/contracts';
import type { Core } from './core.ts';
import { writesTitles } from './drivers/index.ts';
import { invalidParams } from './errors.ts';
import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_SETTINGS: Settings = {
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

  get(): Settings {
    const stored = this.core.journal.getSetting('settings');
    if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS };
    const patch = { ...stored } as Partial<Settings>;
    Reflect.deleteProperty(patch, 'maxConcurrentTurns');
    Reflect.deleteProperty(patch, 'perAccountConcurrency');
    return { ...DEFAULT_SETTINGS, ...patch };
  }

  set(patch: Partial<Settings>, persistPrivate?: () => void): Settings {
    // Shared with the in-memory client: a pasted address is stored as its bare origin.
    const checked = checkSettingsPatch(patch);
    if (!checked.ok) throw invalidParams(checked.message, { field: checked.field });
    const storage = checked.patch.worktreeStorage;
    if (storage?.directory) {
      if (!isAbsolute(storage.directory) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\)/i.test(storage.directory))) {
        throw invalidParams('worktreeStorage.directory must be an absolute folder path on this machine', { field: 'worktreeStorage' });
      }
      storage.directory = resolve(storage.directory);
    }
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
    const next: Settings = { ...this.get(), ...checked.patch };
    this.core.journal.append({ type: 'settings.changed', threadId: null, version: 1, payload: next }, () => {
      // Private credentials share the transaction, never its public event payload.
      persistPrivate?.();
      this.core.journal.setSetting('settings', next);
    });
    this.core.scheduler.onSettingsChanged();
    this.core.procs.applySettings(next);
    this.core.bus.emit('settings.updated', next);
    if (checked.patch.subscriptionProxy !== undefined) {
      for (const account of this.core.accounts.list()) {
        const provider = this.core.providers.get(account.providerId);
        if (provider && ['claude-sdk', 'codex-appserver'].includes(provider.protocol)) {
          this.core.journal.deleteSetting(`account-auth-rejected:${account.id}`);
          this.core.accounts.check(account.id, true);
        }
      }
    }
    return next;
  }
}

export function registerSettingsMethods(core: Core): void {
  core.router.register('settings.get', () => core.settings.get());
  core.router.register('settings.set', (params) => core.settings.set(params));
}
