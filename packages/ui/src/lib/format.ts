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
