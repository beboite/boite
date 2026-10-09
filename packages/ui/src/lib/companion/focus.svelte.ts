/*
 * The companion's timer and the focus mode, for the companion's window.
 *
 * The timer (a pomodoro, a countdown or a stopwatch) ticks once a second while
 * a phase runs and tells the page when one ends (`pomodoro.ts` holds the
 * arithmetic and the storage). Focus is on when the user or the agent turned
 * it on, or during a pomodoro's work with "Focus during work" on: the threads
 * that finish meanwhile are set aside instead of shown, and listed in one card
 * once it ends. What blocks the user (permissions, questions, reminders) is
 * never held back.
 */
import type { Cue } from './sounds';
import { elapsedMs, nextPhase, pausePomodoro, readPomodoro, remainingMs, resumePomodoro, settlePomodoro, startCountdown, startPomodoro, startStopwatch, writePomodoro, type Pomodoro, type PomodoroPhase } from './pomodoro';

export interface TimerHost {
  /** Phases that ended, in order, of the timer that ran: the page rings once for them. */
  ended(phases: PomodoroPhase[], timer: Pomodoro): void;
}

export class PomodoroTimer {
  current = $state<Pomodoro | null>(null);
  now = $state(Date.now());
  readonly left = $derived(this.current ? remainingMs(this.current, this.now) : 0);
  /** What a stopwatch shows. */
  readonly elapsed = $derived(this.current ? elapsedMs(this.current, this.now) : 0);
  readonly kind = $derived(this.current?.kind ?? null);
  readonly phase = $derived(this.current?.phase ?? null);
  /** A pomodoro's work: what turns the focus on by itself. */
  readonly working = $derived(this.current?.kind === 'pomodoro' && this.current.phase === 'work');
  readonly paused = $derived(this.current?.pausedLeft != null);
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly host: TimerHost) {
    this.current = readPomodoro();
    // A phase that ended while the window was closed rings once it is up.
    queueMicrotask(() => this.tick());
  }

  /** One timer at a time: each start replaces the one running. */
  start(options: { workMs: number; breakMs: number; label?: string }): void {
    this.put(startPomodoro(options, Date.now()));
  }

  countdown(ms: number, label = ''): void {
    this.put(startCountdown(ms, label, Date.now()));
  }

  stopwatch(label = ''): void {
    this.put(startStopwatch(label, Date.now()));
  }

  pause(): void {
    if (this.current) this.put(pausePomodoro(this.current, Date.now()));
  }

  resume(): void {
    if (this.current) this.put(resumePomodoro(this.current, Date.now()));
  }

  stop(): void {
    this.put(null);
  }

  /** The break is skipped, or the work cut short: on to what follows, without a chime. */
  skip(): void {
    if (this.current) this.put(nextPhase(this.current, Date.now()));
  }

  private put(next: Pomodoro | null) {
    this.current = next;
    this.now = Date.now();
    writePomodoro(next);
    this.schedule();
  }

  private tick() {
    // The first tick is queued: a timer disposed meanwhile stays quiet.
    if (this.disposed) return;
    this.now = Date.now();
    const ran = this.current;
    const { pomodoro, ended } = settlePomodoro(ran, this.now);
    if (ran && ended.length > 0) {
      this.put(pomodoro);
      this.host.ended(ended, ran);
    } else this.schedule();
  }

  /** The clock runs while a phase does; a paused or stopped timer costs nothing. */
  private schedule() {
    const running = this.current !== null && this.current.pausedLeft === null;
    if (running && this.timer === undefined) this.timer = setInterval(() => this.tick(), 1000);
    else if (!running && this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** A thread that finished during the focus, for the card at its end. */
export interface SetAside {
  threadId: string;
  title: string;
  failed: boolean;
}

export const FOCUS_STORAGE_KEY = 'boite.companion.focus';

/** The cues that still ring in focus: an agent stopped on the user, a reminder, the pomodoro's own. */
const FOCUS_CUES: ReadonlySet<Cue> = new Set<Cue>(['call', 'remind', 'phase']);

export function audible(cue: Cue, focused: boolean): boolean {
  return !focused || FOCUS_CUES.has(cue);
}

function setAsideOf(value: unknown): SetAside[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const item = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    return typeof item.threadId === 'string' && item.threadId ? [{ threadId: item.threadId, title: typeof item.title === 'string' ? item.title : '', failed: item.failed === true }] : [];
  });
}

export interface FocusHost {
  /** Focus by itself: a pomodoro's work, with the option on. */
  auto(): boolean;
}

export class Focus {
  /** The user's or the agent's word; null follows the pomodoro. */
  manual = $state<boolean | null>(null);
  aside = $state<SetAside[]>([]);
  /** What was set aside, once the focus ended. */
  recap = $state<SetAside[]>([]);
  /** Read each time, not derived: `auto` may read state a derived would not see change. */
  get active(): boolean {
    return this.manual ?? this.host.auto();
  }

  constructor(private readonly host: FocusHost) {
    try {
      const raw = JSON.parse(window.localStorage.getItem(FOCUS_STORAGE_KEY) ?? 'null') as Record<string, unknown> | null;
      this.manual = typeof raw?.manual === 'boolean' ? raw.manual : null;
      this.aside = setAsideOf(raw?.aside);
      this.recap = setAsideOf(raw?.recap);
    } catch {
      /* nothing kept */
    }
  }

  set(on: boolean): void {
    this.manual = on;
    this.save();
  }

  toggle(): void {
    this.set(!this.active);
  }

  /** A new work phase: an earlier "off" no longer holds, the pomodoro decides again. */
  release(): void {
    if (this.manual !== false) return;
    this.manual = null;
    this.save();
  }

  /** A finished thread, held back while the focus lasts. */
  keep(item: SetAside): void {
    this.aside = [...this.aside.filter((entry) => entry.threadId !== item.threadId), item];
    this.save();
  }

  /** Called when the focus may have ended: what was set aside goes to the card. */
  follow(): void {
    if (this.active || this.aside.length === 0) return;
    const ids = new Set(this.aside.map((entry) => entry.threadId));
    this.recap = [...this.recap.filter((entry) => !ids.has(entry.threadId)), ...this.aside];
    this.aside = [];
    this.save();
  }

  /** One thread of the card was opened, or the whole card dismissed. */
  drop(threadId: string | null): void {
    this.recap = threadId === null ? [] : this.recap.filter((entry) => entry.threadId !== threadId);
    this.save();
  }

  private save() {
    try {
      window.localStorage.setItem(FOCUS_STORAGE_KEY, JSON.stringify({ manual: this.manual, aside: this.aside, recap: this.recap }));
    } catch {
      /* a refused storage still runs for this session */
    }
  }
}
