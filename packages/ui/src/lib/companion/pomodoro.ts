/*
 * The companion's timer, one at a time, of three kinds:
 * - a pomodoro: a work phase, then a break it takes with the user;
 * - a countdown: one phase that rings when it ends;
 * - a stopwatch: one phase that counts up, to `STOPWATCH_MAX_MS` at most.
 * Every kind is a phase that ends at a time, so pausing, resuming and storing
 * work the same; the stopwatch shows how much of its phase went by. The state
 * is a few numbers kept in `localStorage`, so a reload or a restart of the
 * companion's window finds the timer where it was; a phase that ended
 * meanwhile is over when it opens. Pure, so it is tested without a page.
 */

export type PomodoroPhase = 'work' | 'break';
export type TimerKind = 'pomodoro' | 'countdown' | 'stopwatch';
const KINDS: readonly TimerKind[] = ['pomodoro', 'countdown', 'stopwatch'];

/** A stopwatch left running stops by itself after a day. */
export const STOPWATCH_MAX_MS = 24 * 60 * 60_000;

export interface Pomodoro {
  kind: TimerKind;
  phase: PomodoroPhase;
  /** What it is for, as the user or the agent said; may be empty. */
  label: string;
  workMs: number;
  breakMs: number;
  /** When the phase ends, epoch milliseconds, while it runs. */
  endsAt: number;
  /** What was left of the phase when it was paused; null while it runs. */
  pausedLeft: number | null;
}

export const POMODORO_STORAGE_KEY = 'boite.companion.pomodoro';

export function startPomodoro(options: { workMs: number; breakMs: number; label?: string }, now: number): Pomodoro {
  return { kind: 'pomodoro', phase: 'work', label: options.label?.trim() ?? '', workMs: options.workMs, breakMs: options.breakMs, endsAt: now + options.workMs, pausedLeft: null };
}

export function startCountdown(ms: number, label: string, now: number): Pomodoro {
  return { kind: 'countdown', phase: 'work', label: label.trim(), workMs: ms, breakMs: 0, endsAt: now + ms, pausedLeft: null };
}

export function startStopwatch(label: string, now: number): Pomodoro {
  return { kind: 'stopwatch', phase: 'work', label: label.trim(), workMs: STOPWATCH_MAX_MS, breakMs: 0, endsAt: now + STOPWATCH_MAX_MS, pausedLeft: null };
}

export function remainingMs(pomodoro: Pomodoro, now: number): number {
  return pomodoro.pausedLeft ?? Math.max(0, pomodoro.endsAt - now);
}

/** How long the phase has run: what a stopwatch shows. */
export function elapsedMs(pomodoro: Pomodoro, now: number): number {
  return Math.max(0, pomodoro.workMs - remainingMs(pomodoro, now));
}

export function pausePomodoro(pomodoro: Pomodoro, now: number): Pomodoro {
  return pomodoro.pausedLeft !== null ? pomodoro : { ...pomodoro, pausedLeft: remainingMs(pomodoro, now) };
}

export function resumePomodoro(pomodoro: Pomodoro, now: number): Pomodoro {
  return pomodoro.pausedLeft === null ? pomodoro : { ...pomodoro, endsAt: now + pomodoro.pausedLeft, pausedLeft: null };
}

/** The phase after this one, starting at `from`: a pomodoro's work leads to its break; anything else to the end. */
export function nextPhase(pomodoro: Pomodoro, from: number): Pomodoro | null {
  if (pomodoro.kind !== 'pomodoro' || pomodoro.phase === 'break') return null;
  return { ...pomodoro, phase: 'break', endsAt: from + pomodoro.breakMs, pausedLeft: null };
}

/**
 * The timer at `now`: the phases that ended since it was last read, in order,
 * and what runs now. A break that would have started while the window was
 * closed starts when the work ended, so it may be over already.
 */
export function settlePomodoro(pomodoro: Pomodoro | null, now: number): { pomodoro: Pomodoro | null; ended: PomodoroPhase[] } {
  const ended: PomodoroPhase[] = [];
  let current = pomodoro;
  while (current && current.pausedLeft === null && current.endsAt <= now) {
    ended.push(current.phase);
    current = nextPhase(current, current.endsAt);
  }
  return { pomodoro: current, ended };
}

const span = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/** What is stored, read field by field: a timer missing a field it needs is no timer. */
export function parsePomodoro(raw: unknown): Pomodoro | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  // A timer stored before the kinds existed is a pomodoro.
  const kind = KINDS.find((entry) => entry === value.kind) ?? (value.kind === undefined ? 'pomodoro' : null);
  if (kind === null) return null;
  const [workMs, endsAt] = [span(value.workMs), span(value.endsAt)];
  // Only a pomodoro has a break.
  const breakMs = kind === 'pomodoro' ? span(value.breakMs) : 0;
  const phase = kind === 'pomodoro' ? value.phase : value.phase === 'work' ? 'work' : null;
  if ((phase !== 'work' && phase !== 'break') || workMs === null || breakMs === null || endsAt === null) return null;
  const pausedLeft = typeof value.pausedLeft === 'number' && Number.isFinite(value.pausedLeft) && value.pausedLeft >= 0 ? value.pausedLeft : null;
  return { kind, phase, label: typeof value.label === 'string' ? value.label : '', workMs, breakMs, endsAt, pausedLeft };
}

export function readPomodoro(): Pomodoro | null {
  try {
    const raw = window.localStorage.getItem(POMODORO_STORAGE_KEY);
    return raw === null ? null : parsePomodoro(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function writePomodoro(pomodoro: Pomodoro | null): void {
  try {
    if (pomodoro) window.localStorage.setItem(POMODORO_STORAGE_KEY, JSON.stringify(pomodoro));
    else window.localStorage.removeItem(POMODORO_STORAGE_KEY);
  } catch {
    /* a refused storage still runs for this session */
  }
}

/**
 * `24:59`, or `1:04:59` past an hour. A countdown rounds up, so its last
 * second reads `0:01`; a stopwatch rounds down, so it starts at `0:00`.
 */
export function clock(ms: number, round: 'up' | 'down' = 'up'): string {
  const total = (round === 'up' ? Math.ceil : Math.floor)(Math.max(0, ms) / 1000);
  const [hours, minutes, seconds] = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60];
  const pad = (part: number) => String(part).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
