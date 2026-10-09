/*
 * The desktop companion's preferences: a client preference like the
 * experiments, kept in `localStorage` under `boite.companion` as one JSON
 * object. The main window writes them from Settings, Companion; the companion
 * window reads them and follows a change through the `storage` event, which a
 * page receives for writes made by the other pages of its origin. Both
 * webviews of the shell share the origin and the profile, so they share this.
 *
 * `threadId` is the conversation the companion talks in. It is cleared when
 * the brain changes (model, account, effort, control mode), because a thread
 * keeps the agent and permission mode it was made with.
 */

export type CompanionAnchor = 'left' | 'center' | 'right';
/** `ask`: every action waits for Allow or Deny. `auto`: the agent acts without asking. */
export type CompanionControl = 'ask' | 'auto';

export interface CompanionPrefs {
  /** The screen's name as the shell lists it; null is the primary screen. */
  monitor: string | null;
  anchor: CompanionAnchor;
  /** Null lets the companion take the first agent that is on and signed in, on its small model. */
  providerId: string | null;
  accountId: string | null;
  model: string | null;
  effort: string | null;
  control: CompanionControl;
  /** React to the music playing and show its controls. */
  music: boolean;
  threadId: string | null;
}

export const COMPANION_STORAGE_KEY = 'boite.companion';

export const DEFAULT_COMPANION_PREFS: CompanionPrefs = {
  monitor: null,
  anchor: 'center',
  providerId: null,
  accountId: null,
  model: null,
  effort: null,
  control: 'ask',
  music: true,
  threadId: null
};

/** The fields a thread is made with: changing one starts a new conversation. */
const BRAIN_KEYS = ['providerId', 'accountId', 'model', 'effort', 'control'] as const;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Whatever is stored, read field by field: a missing or wrong field takes its default. */
export function parseCompanionPrefs(raw: unknown): CompanionPrefs {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    monitor: text(value.monitor),
    anchor: value.anchor === 'left' || value.anchor === 'right' ? value.anchor : 'center',
    providerId: text(value.providerId),
    accountId: text(value.accountId),
    model: text(value.model),
    effort: text(value.effort),
    control: value.control === 'auto' ? 'auto' : 'ask',
    music: value.music !== false,
    threadId: text(value.threadId)
  };
}

export function readCompanionPrefs(): CompanionPrefs {
  try {
    const raw = window.localStorage.getItem(COMPANION_STORAGE_KEY);
    return parseCompanionPrefs(raw === null ? null : JSON.parse(raw));
  } catch {
    return { ...DEFAULT_COMPANION_PREFS };
  }
}

type Listener = (prefs: CompanionPrefs) => void;
const listeners = new Set<Listener>();

/** Merges `patch`, forgets the conversation when the brain changed, stores and tells this page. */
export function writeCompanionPrefs(patch: Partial<CompanionPrefs>): CompanionPrefs {
  const before = readCompanionPrefs();
  const next = parseCompanionPrefs({ ...before, ...patch });
  if (!('threadId' in patch) && BRAIN_KEYS.some((key) => before[key] !== next[key])) next.threadId = null;
  try {
    window.localStorage.setItem(COMPANION_STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* a refused storage still runs for this session */
  }
  for (const listener of listeners) listener(next);
  return next;
}

/** Runs on a write from this page or from the other window. Returns the function that stops it. */
export function subscribeCompanionPrefs(listener: Listener): () => void {
  const fromOtherPage = (event: StorageEvent) => {
    if (event.key === COMPANION_STORAGE_KEY) listener(readCompanionPrefs());
  };
  listeners.add(listener);
  window.addEventListener('storage', fromOtherPage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromOtherPage);
  };
}
