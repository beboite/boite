import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentRoutine } from '@boite/contracts';
import { describeSchedule, localZone, previewNext, routineName, routineState } from './schedule';

const zone = localZone();
// Tuesday 2026-10-06, 10:00 local.
const now = new Date(2026, 9, 6, 10, 0).getTime();
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

test('a schedule reads as one sentence, in the words a person would use', () => {
  expect(describeSchedule({ kind: 'interval', everyMinutes: 60 })).toBe('Every hour');
  expect(describeSchedule({ kind: 'interval', everyMinutes: 120 })).toBe('Every 2 hours');
  expect(describeSchedule({ kind: 'interval', everyMinutes: 45 })).toBe('Every 45 minutes');
  expect(describeSchedule({ kind: 'interval', everyMinutes: 2880 })).toBe('Every 2 days');
  expect(describeSchedule({ kind: 'daily', time: '09:00', timezone: zone })).toBe('Every day at 9:00 AM');
  expect(describeSchedule({ kind: 'daily', time: '09:00', timezone: zone, days: [1, 2, 3, 4, 5] })).toBe('Weekdays at 9:00 AM');
  expect(describeSchedule({ kind: 'daily', time: '10:30', timezone: zone, days: [0, 6] })).toBe('Weekends at 10:30 AM');
  expect(describeSchedule({ kind: 'daily', time: '18:00', timezone: zone, days: [5, 1] })).toBe('Every Monday and Friday at 6:00 PM');
  expect(describeSchedule({ kind: 'once', at: new Date(2026, 9, 7, 9, 0).getTime() })).toBe('Once, tomorrow at 9:00 AM');
  // A routine saved on a machine in another zone names it.
  const away = zone === 'Asia/Tokyo' ? 'Europe/Paris' : 'Asia/Tokyo';
  expect(describeSchedule({ kind: 'daily', time: '09:00', timezone: away })).toBe(`Every day at 9:00 AM (${away})`);
});

test('the form previews the next run on a picked weekday, later today or on a later day', () => {
  expect(previewNext({ kind: 'daily', time: '11:00', timezone: zone })).toBe(new Date(2026, 9, 6, 11, 0).getTime());
  expect(previewNext({ kind: 'daily', time: '09:00', timezone: zone })).toBe(new Date(2026, 9, 7, 9, 0).getTime());
  // Tuesday at 10:00: Monday's 09:00 is next week.
  expect(previewNext({ kind: 'daily', time: '09:00', timezone: zone, days: [1] })).toBe(new Date(2026, 9, 12, 9, 0).getTime());
  expect(previewNext({ kind: 'once', at: now - 1 })).toBeNull();
});

test('a routine names itself from its first words and says where it stands', () => {
  expect(routineName('Sum up the new issues.\nThen post them.')).toBe('Sum up the new issues.');
  expect(routineName('Read every new message in the shared inbox and tell me which ones need an answer today')).toBe('Read every new message in the shared inbox and tell me...');
  const routine = { schedule: { kind: 'once', at: now + 60_000 }, enabled: true, nextAt: now + 60_000, lastScheduledAt: null } as AgentRoutine;
  expect(routineState(routine)).toEqual({ kind: 'next', text: 'Next: today at 10:01 AM' });
  expect(routineState({ ...routine, enabled: false, nextAt: null }).kind).toBe('paused');
  expect(routineState({ ...routine, lastScheduledAt: now, nextAt: null }).kind).toBe('done');
});
