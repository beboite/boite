import { expect, test } from 'vitest';
import { activityCommand } from './activity-command';

test('goal and loop commands preserve text and parse duration units', () => {
  expect(activityCommand('/goal Ship the fix\nand verify it')).toEqual({ goal: { objective: 'Ship the fix\nand verify it' } });
  expect(activityCommand('/loop 2h Check the build')).toEqual({ loop: { prompt: 'Check the build', intervalMs: 7_200_000 } });
  expect(activityCommand('/loop Check the build')).toEqual({ loop: { prompt: 'Check the build', intervalMs: 300_000 } });
  expect(activityCommand('/goalkeeper test')).toBeNull();
  expect(activityCommand('ordinary message')).toBeNull();
});

test('empty commands and invalid loop intervals are refused before sending', () => {
  for (const text of ['/goal', '/loop', '/loop 0s test', '/loop 25h test', '/loop 2d test', '/loop 5m']) {
    expect(() => activityCommand(text)).toThrow();
  }
});
