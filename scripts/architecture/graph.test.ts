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

test('a component script is a module: its imports are edges and its component imports resolve', () => {
  const graph = dependencyGraph(new Map([
    ['packages/ui/src/lib/open.ts', "export const open = () => import('../components/Panel.svelte');"],
    ['packages/ui/src/components/Panel.svelte', `<script module lang="ts">import { help } from '../lib/help';</script>
<script lang="ts">import type { T } from '../lib/types'; import Row from './Row.svelte'; let row = $state<T | null>(null);</script>
<Row {row} /><p>import './NotAnImport.svelte'</p>`],
    // Saved with a byte order mark, which Svelte drops before it measures the scripts.
    ['packages/ui/src/components/Row.svelte', "\uFEFF<script lang=\"ts\">import { open } from '../lib/open';</script><button onclick={open}>open</button>"],
    ['packages/ui/src/lib/help.ts', 'export const help = 1;'],
  ]));
  expect(graph.get('packages/ui/src/components/Panel.svelte')).toEqual(['packages/ui/src/components/Row.svelte', 'packages/ui/src/lib/help.ts']);
  expect(cycles(graph)).toEqual([
    'packages/ui/src/lib/open.ts -> packages/ui/src/components/Panel.svelte -> packages/ui/src/components/Row.svelte -> packages/ui/src/lib/open.ts',
  ]);
});

test('a component script or markup expression that imports the core breaks the UI boundary', () => {
  const graph = dependencyGraph(new Map([
    ['packages/ui/src/components/Panel.svelte', "<script lang=\"ts\">import { core } from '@boite/core';</script>"],
    ['packages/ui/src/components/Button.svelte', "<button onclick={() => import('@boite/core')}>{`import('./NotAnImport.svelte')`}</button>"],
    ['packages/core/src/index.ts', 'export const core = 1;'],
  ]));
  expect(boundaryViolations(graph)).toEqual([
    'packages/ui/src/components/Panel.svelte -> packages/core/src/index.ts: the UI must use contracts, not core implementation',
    'packages/ui/src/components/Button.svelte -> packages/core/src/index.ts: the UI must use contracts, not core implementation',
  ]);
});

test('a missing component and a broken component script fail loudly with the file', () => {
  expect(() => dependencyGraph(new Map([['a.ts', "import Gone from './Gone.svelte';"]]))).toThrow('a.ts: cannot resolve runtime import ./Gone.svelte');
  expect(() => dependencyGraph(new Map([['A.svelte', '<script>import {</script>']]))).toThrow('A.svelte:');
});
