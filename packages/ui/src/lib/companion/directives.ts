/*
 * The lines the companion's agent adds to a reply for the companion itself,
 * as its role asks (`brain.ts`): `[[remember: …]]`, `[[forget: …]]`,
 * `[[remind: when | what]]`, `[[timer: duration | what for]]`,
 * `[[pomodoro: duration | what for]]`, `[[stopwatch: what for]]`,
 * `[[focus: on]]`, `[[task: project | instruction]]`, `[[find: words]]` and
 * `[[open: thread id]]`. The bubble never shows them; the page acts on them
 * once the reply is complete. Pure, so it is tested without a core.
 */
import type { TimerKind } from './pomodoro';

/**
 * A timer to start, or the one running to stop. A countdown has a length; a
 * pomodoro's is the user's work length when null; a stopwatch has none.
 */
export type TimerDirective = { kind: TimerKind; ms: number | null; label: string } | 'stop';

/** Work handed to another agent: a new thread in the project named, started with the instruction. */
export interface TaskDirective {
  project: string;
  prompt: string;
}

export interface Directives {
  remember: string[];
  forget: string[];
  remind: { text: string; at: number }[];
  /** The last timer line of the reply wins; null when there is none. */
  timer: TimerDirective | null;
  /** Focus on or off, the last line winning; null when the reply leaves it. */
  focus: boolean | null;
  /** In the order written, `TASKS_MAX` at most. */
  task: TaskDirective[];
  /** Words to look for in the user's threads, the last line winning; null when there is none. */
  find: string | null;
  /** A thread to open in Boite, by its id, the last line winning. */
  open: string | null;
}

const DIRECTIVE = /\[\[\s*(remember|forget|remind|timer|pomodoro|stopwatch|focus|task|find|open|context)\s*:([\s\S]*?)\]\]/gi;
/** A timer is a few minutes to a few hours. */
const TIMER_MAX_MS = 4 * 60 * 60_000;
/** A reply launches a few threads at most: more is a reply gone wrong. */
const TASKS_MAX = 3;
/** A directive still being written while the reply streams. */
const UNFINISHED = /\[\[(?![\s\S]*\]\])[\s\S]*$/;

/** The reply as the bubble shows it: no directive, finished or not. */
export function visibleReply(text: string): string {
  return text
    .replace(DIRECTIVE, '')
    .replace(UNFINISHED, '')
    .replace(/\[$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const pad = (value: number) => String(value).padStart(2, '0');

/**
 * When a reminder rings, epoch milliseconds: a delay (`+45s`, `+20m`,
 * `+1h30m`), a time today or, once past, tomorrow (`18:30`), or a local date
 * and time (`2026-10-12 09:00`). Null for anything else or for a past date.
 */
export function parseWhen(when: string, now: Date): number | null {
  const text = when.trim().toLowerCase();
  const delay = /^\+\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(text);
  if (delay && (delay[1] || delay[2] || delay[3])) {
    const [hours, minutes, seconds] = [delay[1], delay[2], delay[3]].map((part) => Number(part ?? 0));
    const ms = ((hours! * 60 + minutes!) * 60 + seconds!) * 1000;
    return ms > 0 ? now.getTime() + ms : null;
  }
  const clock = /^(\d{1,2})[:h](\d{2})$/.exec(text);
  if (clock) {
    const [hours, minutes] = [Number(clock[1]), Number(clock[2])];
    if (hours > 23 || minutes > 59) return null;
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.getTime();
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (date) {
    const [year, month, day, hours, minutes] = date.slice(1).map(Number) as [number, number, number, number, number];
    const at = new Date(year, month - 1, day, hours, minutes);
    // `new Date` rolls an impossible date over (31 February): refuse it instead.
    const exact = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    if (exact !== `${year}-${pad(month)}-${pad(day)} ${pad(hours)}:${pad(minutes)}`) return null;
    return at.getTime() > now.getTime() ? at.getTime() : null;
  }
  return null;
}

/**
 * A timer's length in milliseconds: `25m`, `25 min`, `1h`, `1h30m`, `90s`, a
 * bare number of minutes (`25`), with or without a leading `+`. Null for
 * anything else, nothing, or more than four hours.
 */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(/^\+\s*/, '');
  if (/^\d+$/.test(value)) return bounded(Number(value) * 60_000);
  const parts = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(value);
  if (!parts || !(parts[1] || parts[2] || parts[3])) return null;
  const [hours, minutes, seconds] = [parts[1], parts[2], parts[3]].map((part) => Number(part ?? 0));
  return bounded(((hours! * 60 + minutes!) * 60 + seconds!) * 1000);
}

const bounded = (ms: number): number | null => (ms > 0 && ms <= TIMER_MAX_MS ? ms : null);

const STOP = /^(stop|off|cancel|end)$/i;

/**
 * `timer: 10m | pasta` counts down and needs its length; `pomodoro: 25m | the
 * report` may leave it out (`pomodoro: | the report`, or `pomodoro:` alone);
 * `stopwatch: the run` has only what it is for. Any of them takes `stop`.
 */
function timerOf(kind: TimerKind, content: string): TimerDirective | null {
  const bar = content.indexOf('|');
  const head = (bar < 0 ? content : content.slice(0, bar)).trim();
  if (STOP.test(head)) return 'stop';
  if (kind === 'stopwatch') return { kind, ms: null, label: content.trim() };
  const label = bar < 0 ? '' : content.slice(bar + 1).trim();
  const ms = parseDuration(head);
  if (kind === 'countdown') return ms === null ? null : { kind, ms, label };
  // A pomodoro without a readable length still starts, at the user's length.
  return { kind, ms, label: ms === null && bar < 0 ? head : label };
}

/** `project | instruction`, both needed; the instruction may hold bars of its own. */
function taskOf(content: string): TaskDirective | null {
  const bar = content.indexOf('|');
  if (bar < 0) return null;
  const [project, prompt] = [content.slice(0, bar).trim(), content.slice(bar + 1).trim()];
  return project && prompt ? { project, prompt } : null;
}

/** The directive's name for each kind of timer. */
const TIMER_KINDS = new Map<string, TimerKind>([['timer', 'countdown'], ['pomodoro', 'pomodoro'], ['stopwatch', 'stopwatch']]);

/** What a complete reply asks of the companion. A directive it cannot read is left out. */
export function parseDirectives(text: string, now: Date): Directives {
  const found: Directives = { remember: [], forget: [], remind: [], timer: null, focus: null, task: [], find: null, open: null };
  for (const [, kind, body] of text.matchAll(DIRECTIVE)) {
    const content = body!.trim();
    const name = kind!.toLowerCase();
    const timer = TIMER_KINDS.get(name);
    // A pomodoro or a stopwatch needs nothing more than its name.
    if (timer) found.timer = timerOf(timer, content) ?? found.timer;
    // The line the companion adds to a request (`contextLine`) asks nothing.
    else if (!content || name === 'context') continue;
    else if (name === 'remember') found.remember.push(content);
    else if (name === 'forget') found.forget.push(content);
    else if (name === 'find') found.find = content;
    else if (name === 'open') found.open = content;
    else if (name === 'task') {
      const task = taskOf(content);
      if (task && found.task.length < TASKS_MAX) found.task.push(task);
    }
    else if (name === 'focus') {
      if (/^(on|start)$/i.test(content)) found.focus = true;
      else if (/^(off|stop|end)$/i.test(content)) found.focus = false;
    } else {
      const bar = content.indexOf('|');
      if (bar < 0) continue;
      const at = parseWhen(content.slice(0, bar), now);
      const what = content.slice(bar + 1).trim();
      if (at !== null && what) found.remind.push({ text: what, at });
    }
  }
  return found;
}
