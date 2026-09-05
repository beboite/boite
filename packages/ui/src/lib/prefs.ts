import type { PermissionMode } from '@boite/contracts';

/** What the composer remembers between threads: the last provider, account and mode. */
export interface ComposerPrefs {
  providerId: string | null;
  accountId: string | null;
  permissionMode: PermissionMode;
  model: string | null;
}

export const PREFS_STORAGE_KEY = 'boite.composer';

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];

export function defaultPrefs(): ComposerPrefs {
  return { providerId: null, accountId: null, permissionMode: 'default', model: null };
}

export function readPrefs(): ComposerPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return defaultPrefs();
    const parsed = JSON.parse(raw) as Partial<ComposerPrefs>;
    const mode = parsed.permissionMode;
    return {
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : null,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null,
      permissionMode: mode !== undefined && MODES.includes(mode) ? mode : 'default',
      model: typeof parsed.model === 'string' ? parsed.model : null
    };
  } catch {
    return defaultPrefs();
  }
}

export function writePrefs(prefs: ComposerPrefs): void {
  try {
    window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}
