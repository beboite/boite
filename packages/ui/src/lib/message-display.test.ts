import { expect, test } from 'vitest';
import { visibleAnswer, visibleUserText } from './message-display';

test('old goal instructions display only the colored-command input, ordinary text stays intact', () => {
  expect(visibleUserText('Work toward this goal: Ship it\nContinue until the objective is achieved. private instructions')).toBe('/goal Ship it');
  expect(visibleUserText('/goal Ship it')).toBe('/goal Ship it');
  expect(visibleUserText('Discuss Work toward this goal: examples')).toBe('Discuss Work toward this goal: examples');
});
test('protocol markers are invisible while streaming and when complete', () => {
  expect(visibleAnswer('Verified.\n[BOITE_GOAL_COMPLETE]\n')).toBe('Verified.\n');
  expect(visibleAnswer('[BOITE_GOAL_BLOCKED]')).toBe('');
  expect(visibleAnswer('Verified.\n[BOITE_GOAL_COMP')).toBe('Verified.\n');
  expect(visibleAnswer('An inline [BOITE_GOAL_COMPLETE] example')).toBe('An inline [BOITE_GOAL_COMPLETE] example');
});
