import { expect, test } from 'bun:test';
import { boundaryViolations, cycles, dependencyGraph } from './graph.ts';

test('generic TypeScript arrow functions are not parsed as JSX', () => {
  const graph = dependencyGraph(new Map([
    ['a.ts', "import { value } from './b'; export const invoke = async <T>(command: string): Promise<T> => value as T;"],
    ['b.ts', 'export const value = 1;'],
  ]));
  expect(graph.get('a.ts')).toEqual(['b.ts']);
});

test('resolves aliases, barrel exports and lazy imports, but ignores type-only edges', () => {
  const graph = dependencyGraph(new Map([
    ['packages/core/src/a.ts', "import type { B } from './b.ts'; export { C } from './c'; const lazy = () => import('./b.ts');"],
    ['packages/core/src/b.ts', "export { C as B } from './c';"],
    ['packages/core/src/c.ts', "export { C } from '@boite/contracts';"],
    ['packages/contracts/src/index.ts', 'export const C = 1;'],
  ]));
  expect(graph.get('packages/core/src/a.ts')).toEqual(['packages/core/src/b.ts', 'packages/core/src/c.ts']);
  expect(cycles(graph)).toEqual([]);
  expect(boundaryViolations(graph)).toEqual([]);
  const types = dependencyGraph(new Map([['a.ts', "import type { B } from './missing.ts'; export type A = B;"]]));
  expect(types.get('a.ts')).toEqual([]);
});

test('detects cycles and cannot hide an unresolved source import', () => {
  expect(cycles(new Map([['a', ['b']], ['b', ['a']]]))).toEqual(['a -> b -> a']);
  expect(cycles(new Map([['a', ['a']]]))).toEqual(['a -> a']);
  expect(() => dependencyGraph(new Map([['a.ts', "export { value } from './missing';"]]))).toThrow('a.ts: cannot resolve');
});

test.each([
  ['packages/contracts/src/index.ts', 'packages/core/src/core.ts', 'contracts'],
  ['packages/ui/src/lib/fake-client.ts', 'packages/core/src/core.ts', 'UI must use contracts'],
  ['packages/core/src/core.ts', 'packages/ui/src/lib/client.ts', 'core cannot depend on the UI'],
  ['packages/core/src/drivers/codex.ts', 'packages/core/src/platform/windows/jobs.ts', 'native backends'],
  ['packages/core/src/drivers/codex/turn.ts', 'packages/core/src/drivers/codex.ts', 'public entry point'],
])('rejects %s importing %s', (source, target, reason) => {
  expect(boundaryViolations(new Map([[source, [target]]]))[0]).toContain(reason);
});

test('the platform entry point can select a backend', () => {
  expect(boundaryViolations(new Map([['packages/core/src/platform/index.ts', ['packages/core/src/platform/windows/jobs.ts']]]))).toEqual([]);
});

test('external packages, strings and comments do not become workspace dependencies', () => {
  const graph = dependencyGraph(new Map([['a.ts', `
    import 'constructor';
    import 'node:fs';
    // import './missing.ts';
    export const example = "import './missing.ts'";
  `]]));
  expect(graph.get('a.ts')).toEqual([]);
});

test('a new workspace subpath must declare its source mapping', () => {
  expect(() => dependencyGraph(new Map([['a.ts', "import '@boite/core/new-api';"]])))
    .toThrow('a.ts: unmapped workspace import @boite/core/new-api');
});
