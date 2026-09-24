import { expect, test } from 'bun:test';
import { gradeWide, type WideObservation } from './browser-wide-grade.ts';
import type { WideTask } from './browser-wide-tasks.ts';

const task: WideTask = {
  id: 'grader-fixture', site: 'example.test', category: 'search', url: 'https://example.test/',
  goal: 'Search, open the result and expand its details.', values: { search: 'Ada Lovelace' },
  completion: { text: 'Analytical Engine', url: 'https://example.test/article' },
  grader: { all: [
    { kind: 'visited-url', pathname: '/search', query: { q: 'Ada Lovelace' } },
    { kind: 'url', equals: 'https://example.test/article' },
    { kind: 'text', contains: 'Analytical Engine' },
    { kind: 'control', selector: '#details', expanded: true },
  ] },
};
const final: WideObservation = { url: 'https://example.test/article', title: 'Ada', text: 'Analytical Engine', controls: { '#details': [{ expanded: true }] } };
const visited = ['https://example.test/search?q=Ada+Lovelace'];

test('independent grading requires the observed workflow, destination and expanded control', () => {
  expect(gradeWide(task, final, visited, 3).passed).toBe(true);
  expect(gradeWide(task, final, [], 3).passed).toBe(false);
  expect(gradeWide(task, { ...final, text: 'Loading' }, visited, 3).passed).toBe(false);
  expect(gradeWide(task, { ...final, controls: { '#details': [{ expanded: false }] } }, visited, 3).passed).toBe(false);
  expect(gradeWide(task, { ...final, controls: {} }, visited, 3).passed).toBe(false);
});

test('a preexisting result or a matching page on another origin cannot pass', () => {
  expect(gradeWide(task, final, visited, 0).passed).toBe(false);
  expect(gradeWide(task, { ...final, url: 'https://other.test/article' }, visited, 3).passed).toBe(false);
  expect(gradeWide(task, final, ['not a URL'], 3).passed).toBe(false);
  expect(gradeWide(task, final, ['https://other.test/search?q=Ada+Lovelace'], 3).passed).toBe(false);
});

test('field checks require the supplied value and checkbox state', () => {
  const fieldTask = { ...task, grader: { all: [{ kind: 'control' as const, selector: '#field', value: 'exact', checked: true }] } };
  expect(gradeWide(fieldTask, { ...final, controls: { '#field': [{ value: 'exact', checked: true }] } }, [], 1).passed).toBe(true);
  expect(gradeWide(fieldTask, { ...final, controls: { '#field': [{ value: 'wrong', checked: true }] } }, [], 1).passed).toBe(false);
});
