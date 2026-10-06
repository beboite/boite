import type { AgentRoutine, AgentSchedule } from '@boite/contracts';
import { formatLocale } from './i18n.svelte';
import { fill, strings } from './strings';

/*
 * Routines read as sentences: "Every Monday and Thursday at 09:00", "Tomorrow
 * at 09:00". The core stores a schedule as data (`AgentSchedule`); everything
 * a person reads about it is made here, in the language of the moment.
 */

/** Monday first, the order a week is picked in. */
export const WEEK: number[] = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAYS: number[] = [1, 2, 3, 4, 5];
export const WEEKEND: number[] = [0, 6];
/** The intervals a person picks from, in minutes. */
export const INTERVALS: number[] = [15, 30, 60, 120, 360, 720, 1440];

/** A weekday's name in the language of the moment, 0 being Sunday. */
export function weekdayName(day: number, width: 'long' | 'short' | 'narrow' = 'long'): string {
  // 2026-10-04 is a Sunday: day 0, and every other day follows it.
  return new Date(Date.UTC(2026, 9, 4 + day, 12)).toLocaleDateString(formatLocale(), { weekday: width, timeZone: 'UTC' });
}

/** "Every hour", "Every 30 minutes", "Every 2 days": each unit has its own sentence, French agrees them. */
export function everyName(minutes: number): string {
  const t = strings.agents.when;
  if (minutes % 1440 === 0) return minutes === 1440 ? t.everyDay : fill(t.everyDays, { count: String(minutes / 1440) });
  if (minutes % 60 === 0) return minutes === 60 ? t.everyHour : fill(t.everyHours, { count: String(minutes / 60) });
  return fill(t.everyMinutes, { count: String(minutes) });
}

/** A short chip label: "15 min", "2 h". */
export function intervalChip(minutes: number): string {
  const t = strings.agents.when;
  return minutes % 60 === 0 ? fill(t.hoursShort, { count: String(minutes / 60) }) : fill(t.minutesShort, { count: String(minutes) });
}

function list(items: string[]): string {
  try { return new Intl.ListFormat(formatLocale(), { type: 'conjunction' }).format(items); } catch { return items.join(', '); }
}

const sameDays = (a: number[], b: number[]) => a.length === b.length && a.every(day => b.includes(day));

/** The local time zone, which a new schedule is written in. */
export function localZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The schedule as one sentence. A daily schedule in another time zone names its zone. */
export function describeSchedule(schedule: AgentSchedule): string {
  const t = strings.agents.when;
  if (schedule.kind === 'once') return fill(t.onceAt, { date: dateTime(schedule.at) });
  if (schedule.kind === 'interval') return everyName(schedule.everyMinutes);
  const days = schedule.days && schedule.days.length < 7 ? schedule.days : null;
  const time = clock(schedule.time);
  const base = !days ? fill(t.daily, { time })
    : sameDays(days, WEEKDAYS) ? fill(t.weekdays, { time })
      : sameDays(days, WEEKEND) ? fill(t.weekend, { time })
        : fill(t.onDays, { days: list(WEEK.filter(day => days.includes(day)).map(day => weekdayName(day))), time });
  return schedule.timezone === localZone() ? base : `${base} (${schedule.timezone})`;
}

/** An `HH:mm` wall time the way this language writes it: "9:00 AM", "09:00". */
export function clock(time: string): string {
  const [h = 0, m = 0] = time.split(':').map(Number);
  return new Date(2026, 0, 1, h, m).toLocaleTimeString(formatLocale(), { hour: 'numeric', minute: '2-digit' });
}

/** "today at 09:00", "tomorrow at 09:00", "Mon, Oct 12 at 09:00". */
export function dateTime(at: number, now = Date.now()): string {
  const t = strings.agents.when;
  const locale = formatLocale();
  const time = new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const day = dayOffset(at, now);
  if (day === 0) return fill(t.today, { time });
  if (day === 1) return fill(t.tomorrow, { time });
  const date = new Date(at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short', ...(new Date(at).getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
  return fill(t.dateAt, { date, time });
}

/** Local calendar days from `now` to `at`: 0 today, 1 tomorrow, -1 yesterday. */
export function dayOffset(at: number, now = Date.now()): number {
  const start = (value: number) => { const d = new Date(value); d.setHours(0, 0, 0, 0); return d.getTime(); };
  return Math.round((start(at) - start(now)) / 86_400_000);
}

/** A routine that ran its single date: nothing left to pause or resume. */
export function spent(routine: Pick<AgentRoutine, 'schedule' | 'lastScheduledAt' | 'nextAt'>): boolean {
  return routine.schedule.kind === 'once' && routine.lastScheduledAt !== null && routine.nextAt === null;
}

/** Where a routine stands: its next run, paused, or done. */
export function routineState(routine: AgentRoutine): { kind: 'next' | 'paused' | 'done'; text: string } {
  const t = strings.agents.when;
  if (spent(routine) || (routine.enabled && routine.nextAt === null)) return { kind: 'done', text: strings.agents.done };
  if (!routine.enabled) return { kind: 'paused', text: strings.agents.paused };
  return { kind: 'next', text: fill(t.next, { when: dateTime(routine.nextAt!) }) };
}

/** A routine's name when the person gave none: the first words of what it does. */
export function routineName(prompt: string, max = 60): string {
  const line = prompt.trim().split('\n')[0]!.replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,.;:!?]+$/, '')}...`;
}

/**
 * The next run a schedule would have, read in this browser's time: what the
 * form previews before the core computes the real one.
 */
export function previewNext(schedule: AgentSchedule, now = Date.now()): number | null {
  if (schedule.kind === 'once') return schedule.at > now ? schedule.at : null;
  if (schedule.kind === 'interval') return now + schedule.everyMinutes * 60_000;
  const [h = 0, m = 0] = schedule.time.split(':').map(Number);
  for (let offset = 0; offset <= 7; offset++) {
    const at = new Date(now);
    at.setDate(at.getDate() + offset);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= now) continue;
    if (schedule.days && !schedule.days.includes(at.getDay())) continue;
    return at.getTime();
  }
  return null;
}
