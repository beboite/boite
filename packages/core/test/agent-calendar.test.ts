import { expect, test } from 'bun:test';
import type { AgentSchedule } from '@boite/contracts';
import { checkSchedule, nextOccurrence, scheduleText } from '../src/agents/routines.ts';
import { runCli } from '../src/cli.ts';
import { makeAgent } from './agent-fixture.ts';
import { echoThread, startTestCore } from './harness.ts';

test('monthly reminders keep their local day, skipping months without that date', () => {
  const schedule = checkSchedule({ kind: 'monthly', day: 31, time: '09:00', timezone: 'Europe/Paris' } as AgentSchedule);
  expect(schedule).toEqual({ kind: 'monthly', day: 31, time: '09:00', timezone: 'Europe/Paris' });
  const next = (after: string) => new Date(nextOccurrence(schedule, Date.parse(after))!).toISOString();
  expect(next('2027-01-31T07:59:59Z')).toBe('2027-01-31T08:00:00.000Z');
  expect(next('2027-01-31T08:00:00Z')).toBe('2027-03-31T07:00:00.000Z');
  expect(scheduleText(schedule)).toBe('monthly on day 31 at 09:00 Europe/Paris');
});

test('yearly reminders cross years and leap years in the specified timezone', () => {
  const schedule = checkSchedule({ kind: 'yearly', month: 11, day: 14, time: '09:00', timezone: 'Asia/Tokyo' } as AgentSchedule);
  expect(nextOccurrence(schedule, Date.parse('2026-11-14T00:00:00Z'))).toBe(Date.parse('2027-11-14T00:00:00Z'));
  const leap = checkSchedule({ kind: 'yearly', month: 2, day: 29, time: '09:00', timezone: 'UTC' } as AgentSchedule);
  expect(nextOccurrence(leap, Date.parse('2096-02-29T09:00:00Z'))).toBe(Date.parse('2104-02-29T09:00:00Z'));
  expect(scheduleText(schedule)).toBe('yearly on 11-14 at 09:00 Asia/Tokyo');
});

test('calendar reminders skip nonexistent times and fire once when clocks repeat', () => {
  const monthly = checkSchedule({ kind: 'monthly', day: 28, time: '02:30', timezone: 'Europe/Paris' } as AgentSchedule);
  expect(nextOccurrence(monthly, Date.parse('2027-03-28T00:00:00Z'))).toBe(Date.parse('2027-04-28T00:30:00Z'));
  const yearly = checkSchedule({ kind: 'yearly', month: 10, day: 25, time: '02:30', timezone: 'Europe/Paris' } as AgentSchedule);
  expect(nextOccurrence(yearly, Date.parse('2026-10-25T00:00:00Z'))).toBe(Date.parse('2026-10-25T00:30:00Z'));
  expect(nextOccurrence(yearly, Date.parse('2026-10-25T00:30:00Z'))).toBe(Date.parse('2027-10-25T00:30:00Z'));
});

test('calendar reminders reject invalid dates, times and zones by field', () => {
  const schedule = { kind: 'yearly', month: 11, day: 14, time: '09:00', timezone: 'UTC' };
  for (const [over, field] of [
    [{ month: 13 }, 'schedule.month'], [{ month: 4, day: 31 }, 'schedule.day'],
    [{ day: 0 }, 'schedule.day'], [{ day: 1.5 }, 'schedule.day'],
    [{ time: '25:00' }, 'schedule.time'], [{ timezone: 'unknown' }, 'schedule.timezone'],
  ] as const) expect(() => checkSchedule({ ...schedule, ...over } as AgentSchedule)).toThrow(field);
});

test('a delayed reminder never selects the second instance of a repeated local time', () => {
  const after = Date.parse('2026-10-25T01:00:00Z'); // 02:00 again, after the first 02:30.
  const schedules: [AgentSchedule, string][] = [
    [{ kind: 'monthly', day: 25, time: '02:30', timezone: 'Europe/Paris' }, '2026-11-25T01:30:00Z'],
    [{ kind: 'yearly', month: 10, day: 25, time: '02:30', timezone: 'Europe/Paris' }, '2027-10-25T00:30:00Z'],
    [{ kind: 'daily', time: '02:30', timezone: 'Europe/Paris' }, '2026-10-26T01:30:00Z'],
  ];
  for (const [schedule, expected] of schedules) expect(nextOccurrence(schedule, after)).toBe(Date.parse(expected));
});

test('the owner assigns calendar reminders and a bot saves them through its CLI', async () => {
  const h = await startTestCore();
  try {
    const owner = await h.connect();
    const { accountId } = await echoThread(h, owner);
    const { agent, threadId } = await makeAgent(h, owner, { selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } });
    const schedules: AgentSchedule[] = [
      { kind: 'monthly', day: 14, time: '09:00', timezone: 'Europe/Paris' },
      { kind: 'yearly', month: 11, day: 14, time: '09:00', timezone: 'Europe/Paris' },
      { kind: 'once', at: Date.parse('2030-11-14T08:00:00Z') },
    ];
    for (const schedule of schedules) {
      const saved = await owner.call('agents.routine.save', { value: { agentId: agent.id, name: schedule.kind, prompt: 'Review the notes', schedule, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
      expect(saved.schedule).toEqual(schedule);
      expect(saved.nextAt).toBeGreaterThan(Date.now());
      let err = '';
      const code = await runCli(['bot', 'schedule', JSON.stringify({ name: `Asked ${schedule.kind}`, prompt: 'Review the notes', schedule })], {
        cwd: h.dataDir, env: { BOITE_THREAD_ID: threadId, BOITE_CORE_URL: h.url, BOITE_AGENT_TOKEN: h.core.agents.tokenFor(threadId) }, out() {}, err: value => { err += value; },
      });
      expect({ code, err }).toEqual({ code: 0, err: '' });
      // Let Bun settle the closed CLI socket before the next connection on Windows.
      await Bun.sleep(5);
    }
    expect(h.core.workforce.records.list('routine')).toHaveLength(6);
  } finally { await h.stop(); }
});
