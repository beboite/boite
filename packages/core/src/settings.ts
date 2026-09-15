import type { Settings } from '@boite/contracts';
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
};

const NUMERIC_KEYS = [
  'maxConcurrentTurns',
  'perAccountConcurrency',
  'warmProcessMinutes',
  'agentCpuCapPercent',
  'threadMemoryCapMb',
] as const;
const BOOLEAN_KEYS = ['listenOnLan', 'focusGuard', 'muteAgents'] as const;
/** Keys whose value is a percentage of the machine, so anything past 100 is a mistake. */
const PERCENT_KEYS = ['agentCpuCapPercent'] as const;

export class SettingsStore {
  constructor(private readonly core: Core) {}

  get(): Settings {
    const stored = this.core.journal.getSetting('settings');
    if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_SETTINGS };
    const patch = stored as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...patch };
  }

  set(patch: Partial<Settings>): Settings {
    if (patch.publicUrl !== undefined && patch.publicUrl !== null) {
      try {
        const url = new URL(patch.publicUrl);
        if (url.protocol !== 'https:' || url.origin !== patch.publicUrl || url.username || url.password) throw new Error();
      } catch {
        throw invalidParams('publicUrl must be an exact HTTPS origin without path, credentials, query or fragment', { field: 'publicUrl' });
      }
    }
    if (patch.browserOrigins !== undefined) {
      const invalid = !Array.isArray(patch.browserOrigins) || patch.browserOrigins.length > 32 ||
        patch.browserOrigins.some((origin) => {
          try {
            const url = new URL(origin);
            return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;
          } catch {
            return true;
          }
        });
      if (invalid) {
        throw invalidParams('browserOrigins must contain at most 32 exact HTTP or HTTPS origins', { field: 'browserOrigins' });
      }
    }
    for (const key of ['maxConcurrentTurns', 'perAccountConcurrency'] as const) {
      const value = patch[key];
      if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
        throw invalidParams(`${key} must be a positive integer`, { field: key });
      }
    }
    for (const key of NUMERIC_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw invalidParams(`${key} must be a number of zero or more`, { field: key });
      }
    }
    for (const key of PERCENT_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value > 100) throw invalidParams(`${key} must be between 0 and 100`, { field: key });
    }
    for (const key of BOOLEAN_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw invalidParams(`${key} must be a boolean`, { field: key });
    }
    const next: Settings = { ...this.get(), ...patch };
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
