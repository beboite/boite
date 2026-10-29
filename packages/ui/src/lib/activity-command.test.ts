import { afterEach, expect, test } from 'vitest';
import { composerActivity, isComposerActivity } from '@boite/contracts';
import { readExperiments } from './experiments';
const activityCommand = (text: string) => composerActivity(text, readExperiments());
const isActivityCommand = (text: string) => isComposerActivity(text, readExperiments());
import { setExperiment } from './experiments';

afterEach(() => setExperiment('goal2', false));

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

test('/goal2 is a reviewed goal only while its experiment is on', () => {
  expect(activityCommand('/goal2 Ship the fix')).toBeNull();
  expect(isActivityCommand('/goal2 Ship the fix')).toBe(false);
  setExperiment('goal2', true);
  expect(activityCommand('/goal2 Ship the fix')).toEqual({ goal: { objective: 'Ship the fix', review: true } });
  expect(isActivityCommand('/goal2 Ship the fix')).toBe(true);
  expect(() => activityCommand('/goal2')).toThrow('/goal2: expected an objective or loop cadence and prompt');
  expect(activityCommand('/goal Ship the fix')).toEqual({ goal: { objective: 'Ship the fix' } });
});
