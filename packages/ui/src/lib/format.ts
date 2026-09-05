import { strings } from './strings';

const units = strings.units;

export function bytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return strings.common.none;
  if (value < 1024) return `${value} ${units.bytes}`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} ${units.kilobytes}`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(0)} ${units.megabytes}`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} ${units.gigabytes}`;
}

export function millis(value: number | null | undefined): string {
  if (value === null || value === undefined) return strings.common.none;
  if (value < 1000) return `${Math.round(value)} ${units.milliseconds}`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} ${units.seconds}`;
  if (value < 3_600_000) return `${(value / 60_000).toFixed(1)} ${units.minutes}`;
  return `${(value / 3_600_000).toFixed(1)} ${units.hours}`;
}

export function duration(startedAt: number, endedAt: number | null): string {
  return millis((endedAt ?? Date.now()) - startedAt);
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});

export function time(value: number): string {
  return clock.format(new Date(value));
}

const counter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function tokens(value: number): string {
  return counter.format(value);
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

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'narrow' });
const dayClock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const calendar = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** "now", "5 min ago", "14:02", "3 Sep": what a sidebar row needs and nothing more. */
export function ago(value: number, now = Date.now()): string {
  const delta = now - value;
  if (delta < 45_000) return strings.time.now;
  if (delta < 3_600_000) return relative.format(-Math.round(delta / 60_000), 'minute');
  const then = new Date(value);
  const today = new Date(now);
  const sameDay =
    then.getFullYear() === today.getFullYear() &&
    then.getMonth() === today.getMonth() &&
    then.getDate() === today.getDate();
  return sameDay ? dayClock.format(then) : calendar.format(then);
}

/** The first line of a prompt, cut for a sidebar row. */
export function titleFrom(prompt: string, max = 60): string {
  const line = prompt.trim().split('\n')[0]?.trim() ?? '';
  if (line.length <= max) return line;
  return line.slice(0, max).trimEnd();
}
