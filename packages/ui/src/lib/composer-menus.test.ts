import { expect, test } from 'vitest';
import { skillSlashItems, slashCompletion } from './composer-menus';

test('manual skill rows keep their descriptions and defer name collisions to driver commands', () => {
  const focus = { name: 'focus', description: 'Focus on one task.', hint: null };
  const native = { name: 'native', description: 'Native command.', hint: '<text>' };
  const rows = skillSlashItems([focus, focus, native], [native]);
  expect(rows).toEqual([{ id: 'skill:focus', kind: 'command', label: '/focus', description: 'Focus on one task.' }]);
  expect(slashCompletion(rows[0]!)).toBe('/focus ');
});

test('manual skill rows omit Boite prompt commands and names that cannot form a token', () => {
  const skills = ['goal', 'goal2', 'loop', 'btw', '', 'my skill', 'focus'].map(name => ({ name, description: null, hint: null }));
  expect(skillSlashItems(skills, []).map(row => row.label)).toEqual(['/focus']);
});

test('manual skill rows omit the chip commands the composer runs itself', () => {
  const skills = ['model', 'effort', 'mode', 'focus'].map(name => ({ name, description: null, hint: null }));
  expect(skillSlashItems(skills, [], ['model', 'effort', 'mode']).map(row => row.label)).toEqual(['/focus']);
});
