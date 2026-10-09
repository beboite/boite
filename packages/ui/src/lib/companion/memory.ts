/*
 * What the companion keeps between conversations, on this computer only, in
 * `localStorage` beside its preferences: the facts it learnt about the user,
 * the reminders it was asked for, and how its shortcut fared, which the
 * Settings page reads from the other window. Nothing of it goes to the core
 * except the facts, which ride in front of a conversation's first request.
 */

export interface MemoryFact {
  id: string;
  text: string;
  /** When it was learnt, epoch milliseconds. */
  at: number;
}

export interface Reminder {
  id: string;
  text: string;
  /** When it rings, epoch milliseconds. */
  at: number;
}

export interface CompanionStatus {
  /** Why the shortcut could not be set, as the shell said; null when it is set or off. */
  hotkeyError: string | null;
}

export const MEMORY_KEY = 'boite.companion.memory';
export const REMINDERS_KEY = 'boite.companion.reminders';
export const STATUS_KEY = 'boite.companion.status';
/** The oldest facts go past this many: the memory rides in every new conversation. */
export const MEMORY_LIMIT = 80;
export const FACT_LENGTH = 200;
export const REMINDER_LIMIT = 50;

const KEYS = new Set([MEMORY_KEY, REMINDERS_KEY, STATUS_KEY]);
const listeners = new Set<() => void>();

const makeId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function load(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function store(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* a refused storage still runs for this session */
  }
  for (const listener of listeners) listener();
}

/** Entries with an id, a text and a time; anything else stored is dropped. */
function entries(key: string): MemoryFact[] {
  const raw = load(key);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const { id, text, at } = (entry ?? {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof text === 'string' && text.trim() !== '' && typeof at === 'number' && Number.isFinite(at) ? [{ id, text, at }] : [];
  });
}

/** Lower case, no accents, single spaces, no closing punctuation: how two facts are compared. */
export function normalized(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').replace(/[\s.!?…;:,]+$/u, '').trim();
}

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

export function readMemory(): MemoryFact[] {
  return entries(MEMORY_KEY);
}

/** Keeps a fact, once: the same one learnt again only moves to the end. */
export function remember(text: string, now = Date.now()): MemoryFact[] {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, FACT_LENGTH);
  if (!clean) return readMemory();
  const key = normalized(clean);
  const kept = readMemory().filter((fact) => normalized(fact.text) !== key);
  const next = [...kept, { id: makeId(now), text: clean, at: now }].slice(-MEMORY_LIMIT);
  store(MEMORY_KEY, next);
  return next;
}

/**
 * Whether `query` names the fact `text`: it contains it or is contained in it,
 * or it holds most of its words, since the agent rarely quotes a fact word for
 * word.
 */
export function namesFact(query: string, text: string): boolean {
  const wanted = normalized(query);
  if (!wanted) return false;
  const fact = normalized(text);
  if (fact.includes(wanted) || wanted.includes(fact)) return true;
  const words = wanted.split(' ').filter((word) => word.length >= 3);
  return words.length >= 2 && words.filter((word) => fact.includes(word)).length / words.length >= 0.6;
}

/** Drops the facts `query` names (`namesFact`). */
export function forget(query: string): MemoryFact[] {
  if (!normalized(query)) return readMemory();
  const next = readMemory().filter((fact) => !namesFact(query, fact.text));
  store(MEMORY_KEY, next);
  return next;
}

export function forgetFact(id: string): MemoryFact[] {
  const next = readMemory().filter((fact) => fact.id !== id);
  store(MEMORY_KEY, next);
  return next;
}

export function clearMemory(): void {
  store(MEMORY_KEY, []);
}

/** The facts as the first request of a conversation carries them. */
export function memoryBlock(facts: MemoryFact[]): string {
  if (facts.length === 0) return 'Your memory of the user is empty so far.';
  return `What you remember about the user:\n${facts.map((fact) => `- ${fact.text}`).join('\n')}`;
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** The reminders still to ring, soonest first. */
export function readReminders(): Reminder[] {
  return entries(REMINDERS_KEY).sort((a, b) => a.at - b.at);
}

export function addReminder(text: string, at: number, now = Date.now()): Reminder[] {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, FACT_LENGTH);
  if (!clean || !Number.isFinite(at)) return readReminders();
  const next = [...readReminders(), { id: makeId(now), text: clean, at }].sort((a, b) => a.at - b.at).slice(0, REMINDER_LIMIT);
  store(REMINDERS_KEY, next);
  return next;
}

export function removeReminder(id: string): Reminder[] {
  const next = readReminders().filter((reminder) => reminder.id !== id);
  store(REMINDERS_KEY, next);
  return next;
}

/** Takes out the reminders due by `now` and returns them, to ring once. */
export function takeDueReminders(now = Date.now()): Reminder[] {
  const all = readReminders();
  const due = all.filter((reminder) => reminder.at <= now);
  if (due.length > 0) store(REMINDERS_KEY, all.filter((reminder) => reminder.at > now));
  return due;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export function readStatus(): CompanionStatus {
  const raw = load(STATUS_KEY) as Record<string, unknown> | null;
  return { hotkeyError: typeof raw?.hotkeyError === 'string' ? raw.hotkeyError : null };
}

export function writeStatus(status: CompanionStatus): void {
  if (readStatus().hotkeyError === status.hotkeyError) return;
  store(STATUS_KEY, status);
}

/** Runs on any change to the memory, the reminders or the status, from this page or the other window. */
export function subscribeCompanionData(listener: () => void): () => void {
  const fromOtherPage = (event: StorageEvent) => {
    if (event.key !== null && KEYS.has(event.key)) listener();
  };
  listeners.add(listener);
  window.addEventListener('storage', fromOtherPage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', fromOtherPage);
  };
}
