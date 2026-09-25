import type { Settings } from './index.ts';

/** The contract builds with no DOM library; the core, the UI and the browser all have `URL`. */
declare const URL: new (value: string) => { protocol: string; origin: string; username: string; password: string };

const NUMERIC_KEYS = [
  'maxConcurrentTurns',
  'perAccountConcurrency',
  'warmProcessMinutes',
  'agentCpuCapPercent',
  'threadMemoryCapMb',
] as const;
const BOOLEAN_KEYS = ['listenOnLan', 'focusGuard', 'muteAgents', 'reapOrphans', 'autoUpdateHarnesses', 'asyncQuestions'] as const;
/** Keys whose value is a percentage of the machine, so anything past 100 is a mistake. */
const PERCENT_KEYS = ['agentCpuCapPercent'] as const;

function exactOrigin(value: string, protocols: readonly string[]): boolean {
  try {
    const url = new URL(value);
    return protocols.includes(url.protocol) && url.origin === value && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Why `settings.set` refuses a patch, or null when it takes it. The core and
 * the in-memory client both answer with this, as InvalidParams naming `field`.
 */
export function settingsPatchError(patch: Partial<Settings>): { message: string; field: string } | null {
  if (patch.publicUrl !== undefined && patch.publicUrl !== null && !exactOrigin(patch.publicUrl, ['https:'])) {
    return { message: 'publicUrl must be an exact HTTPS origin without path, credentials, query or fragment', field: 'publicUrl' };
  }
  if (patch.browserOrigins !== undefined) {
    const origins = patch.browserOrigins as unknown;
    if (!Array.isArray(origins) || origins.length > 32
      || origins.some((origin) => typeof origin !== 'string' || !exactOrigin(origin, ['http:', 'https:']))) {
      return { message: 'browserOrigins must contain at most 32 exact HTTP or HTTPS origins', field: 'browserOrigins' };
    }
  }
  for (const key of ['maxConcurrentTurns', 'perAccountConcurrency'] as const) {
    const value = patch[key];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      return { message: `${key} must be a positive integer`, field: key };
    }
  }
  for (const key of NUMERIC_KEYS) {
    const value = patch[key] as unknown;
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { message: `${key} must be a number of zero or more`, field: key };
    }
  }
  for (const key of PERCENT_KEYS) {
    const value = patch[key];
    if (value !== undefined && value > 100) return { message: `${key} must be between 0 and 100`, field: key };
  }
  for (const key of BOOLEAN_KEYS) {
    const value = patch[key] as unknown;
    if (value !== undefined && typeof value !== 'boolean') return { message: `${key} must be a boolean`, field: key };
  }
  return null;
}
