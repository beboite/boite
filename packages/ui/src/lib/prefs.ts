import type { PermissionMode } from '@boite/contracts';

/** What the composer remembers between threads: the last provider, account, mode, model and effort. */
export interface ComposerPrefs {
  providerId: string | null;
  accountId: string | null;
  permissionMode: PermissionMode;
  model: string | null;
  /** A level id of that model, or null for the model's own default. */
  effort: string | null;
}

/** What the window remembers: the sidebar's width and whether it is folded. */
export interface LayoutPrefs {
  sidebarWidth: number;
  sidebarCollapsed: boolean;
}

export const PREFS_STORAGE_KEY = 'boite.composer';
export const LAYOUT_STORAGE_KEY = 'boite.layout';

export const SIDEBAR_DEFAULT = 280;
export const SIDEBAR_MIN = 208;
export const SIDEBAR_MAX = 440;

const MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk'];

export function defaultPrefs(): ComposerPrefs {
  return { providerId: null, accountId: null, permissionMode: 'default', model: null, effort: null };
}

export function defaultLayout(): LayoutPrefs {
  return { sidebarWidth: SIDEBAR_DEFAULT, sidebarCollapsed: false };
}

export function clampSidebar(width: number): number {
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
}

function read<T>(key: string, fallback: () => T, parse: (raw: Partial<T>) => T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback();
    return parse(JSON.parse(raw) as Partial<T>);
  } catch {
    return fallback();
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

export function readPrefs(): ComposerPrefs {
  return read(PREFS_STORAGE_KEY, defaultPrefs, (parsed) => {
    const mode = parsed.permissionMode;
    return {
      providerId: typeof parsed.providerId === 'string' ? parsed.providerId : null,
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : null,
      permissionMode: mode !== undefined && MODES.includes(mode) ? mode : 'default',
      model: typeof parsed.model === 'string' ? parsed.model : null,
      effort: typeof parsed.effort === 'string' ? parsed.effort : null
    };
  });
}

export function writePrefs(prefs: ComposerPrefs): void {
  write(PREFS_STORAGE_KEY, prefs);
}

export function readLayout(): LayoutPrefs {
  return read(LAYOUT_STORAGE_KEY, defaultLayout, (parsed) => ({
    sidebarWidth:
      typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)
        ? clampSidebar(parsed.sidebarWidth)
        : SIDEBAR_DEFAULT,
    sidebarCollapsed: parsed.sidebarCollapsed === true
  }));
}

export function writeLayout(layout: LayoutPrefs): void {
  write(LAYOUT_STORAGE_KEY, layout);
}

/**
 * What Ctrl+S puts aside: one text per thread, so a prompt written and not sent
 * survives a reload. A draft has no thread id yet and stashes under
 * `DRAFT_STASH_KEY`.
 */
export const STASH_STORAGE_KEY = 'boite:composer-stash:v1';
export const DRAFT_STASH_KEY = 'draft';

function readStashes(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STASH_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStashes(stashes: Record<string, string>): void {
  try {
    if (Object.keys(stashes).length === 0) window.localStorage.removeItem(STASH_STORAGE_KEY);
    else window.localStorage.setItem(STASH_STORAGE_KEY, JSON.stringify(stashes));
  } catch {
    /* a browser that refuses storage still runs for this session */
  }
}

/** The text stashed for one thread, or null when there is none. */
export function readStash(key: string): string | null {
  return readStashes()[key] ?? null;
}

export function writeStash(key: string, text: string): void {
  writeStashes({ ...readStashes(), [key]: text });
}

export function clearStash(key: string): void {
  const stashes = readStashes();
  if (!(key in stashes)) return;
  delete stashes[key];
  writeStashes(stashes);
}
