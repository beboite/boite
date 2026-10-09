/*
 * The lines the companion's agent adds to a reply for the companion itself,
 * as its role asks (`brain.ts`): `[[remember: …]]`, `[[forget: …]]`,
 * `[[remind: when | what]]`, `[[timer: duration | what for]]`,
 * `[[focus: on]]` and `[[task: project | instruction]]`. The bubble never
 * shows them; the page acts on them once the reply is complete. Pure, so it
 * is tested without a core.
 */

/** A pomodoro to start, its work phase lasting `ms`, or the one running to stop. */
export type TimerDirective = { ms: number; label: string } | 'stop';

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
}

const DIRECTIVE = /\[\[\s*(remember|forget|remind|timer|focus|task)\s*:([\s\S]*?)\]\]/gi;
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

function timerOf(content: string): TimerDirective | null {
  const bar = content.indexOf('|');
  const head = (bar < 0 ? content : content.slice(0, bar)).trim();
  if (/^(stop|off|cancel)$/i.test(head)) return 'stop';
  const ms = parseDuration(head);
  return ms === null ? null : { ms, label: bar < 0 ? '' : content.slice(bar + 1).trim() };
}

/** `project | instruction`, both needed; the instruction may hold bars of its own. */
function taskOf(content: string): TaskDirective | null {
  const bar = content.indexOf('|');
  if (bar < 0) return null;
  const [project, prompt] = [content.slice(0, bar).trim(), content.slice(bar + 1).trim()];
  return project && prompt ? { project, prompt } : null;
}

/** What a complete reply asks of the companion. A directive it cannot read is left out. */
export function parseDirectives(text: string, now: Date): Directives {
  const found: Directives = { remember: [], forget: [], remind: [], timer: null, focus: null, task: [] };
  for (const [, kind, body] of text.matchAll(DIRECTIVE)) {
    const content = body!.trim();
    if (!content) continue;
    const name = kind!.toLowerCase();
    if (name === 'remember') found.remember.push(content);
    else if (name === 'forget') found.forget.push(content);
    else if (name === 'timer') found.timer = timerOf(content) ?? found.timer;
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
