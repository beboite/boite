import { formatLocale, strings } from './i18n.svelte';

/*
 * Numbers, sizes and clocks, in the language the app is speaking.
 *
 * `Intl` objects are not free to build, and these are called once per row of
 * every list, so one set is made per formatting tag and kept. The tag comes
 * from `formatLocale()`: changing the language builds a second set and every
 * row drawn after that reads the new one.
 */
interface Formatters {
  clock: Intl.DateTimeFormat;
  dayClock: Intl.DateTimeFormat;
  calendar: Intl.DateTimeFormat;
  relative: Intl.RelativeTimeFormat;
  counter: Intl.NumberFormat;
  plain: Intl.NumberFormat;
  weekday: Intl.DateTimeFormat;
}

const sets = new Map<string, Formatters>();

function formatters(): Formatters {
  const tag = formatLocale();
  const known = sets.get(tag);
  if (known) return known;
  const made: Formatters = {
    clock: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    dayClock: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' }),
    calendar: new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short' }),
    relative: new Intl.RelativeTimeFormat(tag, { numeric: 'auto', style: 'narrow' }),
    counter: new Intl.NumberFormat(tag, { notation: 'compact', maximumFractionDigits: 1 }),
    plain: new Intl.NumberFormat(tag),
    weekday: new Intl.DateTimeFormat(tag, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
  };
  sets.set(tag, made);
  return made;
}

export function bytes(value: number | null | undefined): string {
  const units = strings.units;
  if (value === null || value === undefined) return strings.common.none;
  if (value < 1024) return `${value} ${units.bytes}`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} ${units.kilobytes}`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} ${units.megabytes}`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} ${units.gigabytes}`;
}

export function millis(value: number | null | undefined): string {
  const units = strings.units;
  if (value === null || value === undefined) return strings.common.none;
  if (value < 1000) return `${Math.round(value)} ${units.milliseconds}`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} ${units.seconds}`;
  if (value < 3_600_000) return `${(value / 60_000).toFixed(1)} ${units.minutes}`;
  return `${(value / 3_600_000).toFixed(1)} ${units.hours}`;
}

export function duration(startedAt: number, endedAt: number | null): string {
  return millis((endedAt ?? Date.now()) - startedAt);
}

export function time(value: number): string {
  return formatters().clock.format(new Date(value));
}

/** `10:31` today, `Tue 10:31` within the week, `12 Sep 10:31` before that: when a turn finished. */
export function clockTime(value: number, now = Date.now()): string {
  const set = formatters();
  const then = new Date(value);
  const today = new Date(now);
  if (then.toDateString() === today.toDateString()) return set.dayClock.format(then);
  if (now - value < 6 * 86_400_000) return set.weekday.format(then);
  return `${set.calendar.format(then)} ${set.dayClock.format(then)}`;
}

/** `12s`, `4m 41s`, `1h 02m`: a stopwatch, the way a turn's footer reads it. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** A day and an hour: what a quota window's reset reads as. */
export function weekdayTime(value: number): string {
  return formatters().weekday.format(new Date(value));
}

export function tokens(value: number): string {
  return formatters().counter.format(value);
}

/** Every digit of a count, grouped the way the language groups them. */
export function count(value: number): string {
  return formatters().plain.format(value);
}

export function cost(value: number | null): string {
  if (value === null) return strings.common.unknown;
  return `$${value.toFixed(3)}`;
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function percent(value: number): string {
  return `${Math.round(value)}%`;
}

/** "now", "5 min ago", "14:02", "3 Sep": what a sidebar row needs and nothing more. */
export function ago(value: number, now = Date.now()): string {
  const delta = now - value;
  if (delta < 45_000) return strings.time.now;
  const set = formatters();
  if (delta < 3_600_000) return set.relative.format(-Math.round(delta / 60_000), 'minute');
  const then = new Date(value);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay ? set.dayClock.format(then) : set.calendar.format(then);
}

/** The first line of a prompt, cut for a sidebar row. */
export function titleFrom(prompt: string, max = 60): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= max) return line;
  return line.slice(0, max).trimEnd();
}

/** A project's name as the user reads it: the drafts in the app's own language, any other as the core named it. */
export function projectName(project: { name: string; kind?: 'drafts' } | null | undefined): string {
  if (!project) return '';
  return project.kind === 'drafts' ? strings.drafts.name : project.name;
}
