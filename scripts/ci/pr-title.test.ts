import { expect, test } from 'bun:test';
import { titleProblem } from './pr-title.ts';

test('conventional titles pass, with or without a scope', () => {
  for (const title of [
    'feat: boite CLI for agents and a right panel',
    'fix(ui): one next step per provider',
    'chore(deps): bump the actions group across 1 directory with 3 updates',
    'feat(core)!: drop schema 8 migration',
    'perf(shell/core): cut startup round trips',
  ]) expect(titleProblem(title)).toBeUndefined();
});

test('free-form titles and unknown types are refused by name', () => {
  expect(titleProblem('Simplify chat navigation and activity controls')).toContain('type(scope): summary');
  expect(titleProblem('feature: add dictation')).toContain('unknown type "feature"');
  expect(titleProblem('fix(UI): normalize spacing')).toContain('type(scope): summary');
  expect(titleProblem('fix:missing space')).toContain('type(scope): summary');
  expect(titleProblem('docs: explain pairing.')).toBe('the summary ends with a period');
});
