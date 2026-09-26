import { checkSettingsPatch, type Settings } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams } from './errors.ts';

export const DEFAULT_SETTINGS: Settings = {
  maxConcurrentTurns: 6,
  perAccountConcurrency: 2,
  warmProcessMinutes: 0,
  listenOnLan: false,
  agentCpuCapPercent: 75,
  threadMemoryCapMb: 0,
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
    const patch = stored as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...patch };
  }

  set(patch: Partial<Settings>): Settings {
    // Shared with the in-memory client: a pasted address is stored as its bare origin.
    const checked = checkSettingsPatch(patch);
    if (!checked.ok) throw invalidParams(checked.message, { field: checked.field });
    const next: Settings = { ...this.get(), ...checked.patch };
    this.core.journal.append({ type: 'settings.changed', threadId: null, version: 1, payload: next }, () => {
      this.core.journal.setSetting('settings', next);
    });
    this.core.scheduler.onSettingsChanged();
    this.core.procs.applySettings(next);
    this.core.bus.emit('settings.updated', next);
    return next;
  }
}

export function registerSettingsMethods(core: Core): void {
  core.router.register('settings.get', () => core.settings.get());
  core.router.register('settings.set', (params) => core.settings.set(params));
}
