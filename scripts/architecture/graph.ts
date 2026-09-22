import { posix } from 'node:path';

export type Sources = Map<string, string>;
export type Graph = Map<string, string[]>;
const scanner = new Bun.Transpiler({ loader: 'ts' });
const aliases = new Map([
  ['@boite/contracts', 'packages/contracts/src/index.ts'],
  ['@boite/core', 'packages/core/src/index.ts'],
  ['@boite/core/client', 'packages/core/src/client.ts'],
]);

/** Bun's parser excludes type-only imports and includes literal dynamic imports. */
export function dependencyGraph(sources: Sources): Graph {
  const graph: Graph = new Map();
  for (const [file, source] of sources) {
    const dependencies: string[] = [];
    for (const imported of scanner.scan(source).imports) {
      const specifier = imported.path;
      if (specifier.startsWith('@boite/') && !aliases.has(specifier)) {
        throw new Error(`${file}: unmapped workspace import ${specifier}; add its source to the architecture aliases`);
      }
      const path = aliases.get(specifier) ?? (specifier.startsWith('.') ? posix.normalize(`${posix.dirname(file)}/${specifier}`) : null);
      if (path === null) continue;
      const resolved = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`].find(candidate => sources.has(candidate));
      if (resolved) dependencies.push(resolved);
      else if (/\.[cm]?[jt]sx?$/.test(path) || !posix.extname(path)) {
        throw new Error(`${file}: cannot resolve runtime import ${specifier}`);
      }
    }
    graph.set(file, [...new Set(dependencies)].sort());
  }
  return graph;
}

/** Reports each back edge with its complete cycle, including lazy imports. */
export function cycles(graph: Graph): string[] {
  const done = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];
  const found: string[] = [];
  function visit(file: string): void {
    const at = active.get(file);
    if (at !== undefined) { found.push([...stack.slice(at), file].join(' -> ')); return; }
    if (done.has(file)) return;
    active.set(file, stack.length);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    active.delete(file);
    done.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return found;
}

const core = 'packages/core/src/';
const ui = 'packages/ui/src/';
const contracts = 'packages/contracts/src/';
const internals = [
  `${core}drivers/codex`, `${core}drivers/muse`, `${core}git`, `${core}server`,
  `${ui}lib/fake-client`,
];

export function boundaryViolations(graph: Graph): string[] {
  const errors: string[] = [];
  for (const [file, dependencies] of graph) for (const dependency of dependencies) {
    let reason: string | undefined;
    if (file.startsWith(contracts) && !dependency.startsWith(contracts)) reason = 'contracts cannot depend on a runtime';
    if (file.startsWith(core) && dependency.startsWith(ui)) reason = 'the core cannot depend on the UI';
    if (file.startsWith(ui) && dependency.startsWith(core)) reason = 'the UI must use contracts, not core implementation';
    if (!file.startsWith(`${core}platform/`) && /^packages\/core\/src\/platform\/(windows|posix)\//.test(dependency)) {
      reason = 'native backends belong behind platform/index.ts';
    }
    if (internals.some(root => file.startsWith(`${root}/`) && dependency === `${root}.ts`)) {
      reason = 'an internal module cannot import its public entry point';
    }
    if (reason) errors.push(`${file} -> ${dependency}: ${reason}`);
  }
  return errors;
}
