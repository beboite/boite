import { expect, test } from 'vitest';
import { activityCommand } from './activity-command';

test('goal and loop commands preserve text and parse duration units', () => {
  expect(activityCommand('/goal Ship the fix\nand verify it')).toEqual({ goal: { objective: 'Ship the fix\nand verify it' } });
  expect(activityCommand('/loop 2h Check the build')).toEqual({ loop: { prompt: 'Check the build', intervalMs: 7_200_000 } });
  expect(activityCommand('/loop 2 Check the build')).toEqual({ loop: { prompt: 'Check the build', intervalMs: 0, maxIterations: 2 } });
  expect(activityCommand('/loop teste une loop de 2 itération ou tu dis le mot pong')).toEqual({ loop: { prompt: 'teste une loop de 2 itération ou tu dis le mot pong', intervalMs: 0, maxIterations: 2 } });
  expect(activityCommand('/goalkeeper test')).toBeNull();
  expect(activityCommand('ordinary message')).toBeNull();
});

test('empty commands and invalid loop intervals are refused before sending', () => {
  for (const text of ['/goal', '/loop', '/loop Check the build', '/loop 0s test', '/loop 25h test', '/loop 2d test', '/loop 5m', '/loop 0 pong', '/loop 1001 pong']) {
    expect(() => activityCommand(text)).toThrow();
  }
});
