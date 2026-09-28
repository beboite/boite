import { expect, test } from 'vitest';
import { planFileName, planOf, planTitle } from './plan';

test('only a plan-mode exit with some text is a plan', () => {
  expect(planOf('ExitPlanMode', { plan: '# Do it' })).toBe('# Do it');
  expect(planOf('ExitPlanMode', { plan: '  ' })).toBeNull();
  expect(planOf('ExitPlanMode', null)).toBeNull();
  expect(planOf('Write', { plan: '# Do it' })).toBeNull();
});

test('the title is the first heading, else the first line, without markup', () => {
  expect(planTitle('Intro line\n\n## Port the **scheduler**\n\n1. step')).toBe('Port the scheduler');
  expect(planTitle('\n  Just a line\nmore')).toBe('Just a line');
});

test('the file name is an ASCII slug that steps past the names already there', () => {
  expect(planFileName('# Réécrire le `scheduler` : étape 1')).toBe('plan-reecrire-le-scheduler-etape-1.md');
  expect(planFileName('# Trace tab', ['README.md', 'Plan-Trace-Tab.md', 'plan-trace-tab-2.md'])).toBe('plan-trace-tab-3.md');
  expect(planFileName('!!!')).toBe('plan.md');
  expect(planFileName(`# ${'long '.repeat(30)}`).length).toBeLessThanOrEqual('plan-.md'.length + 48);
});
