import type { AgentSchedule } from './agents';

/** Wall clock of an instant, represented as UTC milliseconds of the same reading. */
function wall(parts: Intl.DateTimeFormat, at: number): number {
  const p: Record<string, number> = {};
  for (const part of parts.formatToParts(at)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!);
}

/** The next instant, strictly after `after`, shared by the host, preview and fake client. */
export function nextAgentOccurrence(schedule: AgentSchedule, after = Date.now()): number | null {
  if (schedule.kind === 'once') return schedule.at > after ? schedule.at : null;
  if (schedule.kind === 'interval') return after + schedule.everyMinutes * 60_000;
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const [h = 0, m = 0] = schedule.time.split(':').map(Number), minutes = h * 60 + m;
  const afterWall = wall(parts, after), afterDay = Math.floor(afterWall / 86_400_000);
  const local = new Date(afterDay * 86_400_000);
  const afterMinutes = Math.floor(afterWall % 86_400_000 / 60_000);
  // Daily: two weeks cover a skipped weekday at DST. Calendar dates jump by
  // month or year; eight years cover February 29 across a non-leap century.
  const attempts = schedule.kind === 'daily' ? 14 : schedule.kind === 'monthly' ? 24 : 8;
  for (let offset = 0; offset <= attempts; offset++) {
    const date = schedule.kind === 'daily' ? new Date((afterDay + offset) * 86_400_000)
      : schedule.kind === 'monthly' ? new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1))
        : new Date(Date.UTC(local.getUTCFullYear() + offset, schedule.month - 1, 1));
    if (schedule.kind !== 'daily') {
      const month = date.getUTCMonth();
      date.setUTCDate(schedule.day);
      if (date.getUTCMonth() !== month) continue;
    } else if (schedule.days && !schedule.days.includes(date.getUTCDay())) continue;
    const day = date.getTime() / 86_400_000;
    if (day < afterDay || (day === afterDay && afterMinutes >= minutes)) continue;
    const target = date.getTime() + minutes * 60_000;
    // Probe both offsets at a clock change. Nonexistent times have no match;
    // repeated times use the first instant, and never run twice that date.
    let found: number | null = null;
    for (const probe of [target - 86_400_000, target + 86_400_000]) {
      const at = target - (wall(parts, probe) - probe);
      if (wall(parts, at) === target && (found === null || at < found)) found = at;
    }
    if (found !== null && found > after) return found;
  }
  throw new Error('schedule: could not find the next local occurrence');
}
