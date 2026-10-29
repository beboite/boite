import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fakeHandlers, scenarioMethods, uncoveredFakeMethods } from '../../../tests/contract/coverage.ts';
import baseline from '../../../tests/contract/fake-coverage-baseline.json';

const root = resolve(import.meta.dir, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');
const fake = ['packages/ui/src/lib/fake-client.ts', ...new Bun.Glob('packages/ui/src/lib/fake-client/**/*.ts').scanSync({ cwd: root })];
const scenarios = [...new Bun.Glob('tests/contract/*.ts').scanSync({ cwd: root })].filter(path => !path.endsWith('/coverage.ts'));
const handlers = fakeHandlers(fake.map(read));
const covered = scenarioMethods(scenarios.map(read));

test('fake handler discovery includes simple arrows and delegated handler references', () => {
  expect(fakeHandlers([`{
    'example.async': async params => params,
    'example.parenthesized': (params) => params,
    'example.simple': params => params,
    'example.delegated': delegatedHandler,
  }`])).toEqual(['example.async', 'example.delegated', 'example.parenthesized', 'example.simple']);
});

test('new fake handlers require a shared scenario rather than silently extending the legacy baseline', () => {
  expect(uncoveredFakeMethods(handlers, covered, baseline)).toEqual([]);
  expect(uncoveredFakeMethods([...handlers, 'composer.untested'], covered, baseline)).toEqual(['composer.untested']);
  expect(uncoveredFakeMethods([...handlers, 'composer.untested'], new Set([...covered, 'composer.untested']), baseline)).toEqual([]);
});
test('the explicit fake coverage baseline contains only current gaps and excludes composer methods', () => {
  expect(baseline.filter(method => !handlers.includes(method) || covered.has(method))).toEqual([]);
  expect(handlers.filter(method => method.startsWith('composer.')).every(method => covered.has(method))).toBe(true);
});
