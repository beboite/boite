import { createRequire } from 'node:module';
import { posix } from 'node:path';

export type Sources = Map<string, string>;
export type Graph = Map<string, string[]>;
const scanner = new Bun.Transpiler({ loader: 'ts' });
const aliases = new Map([
  ['@boite/contracts', 'packages/contracts/src/index.ts'],
  ['@boite/core', 'packages/core/src/index.ts'],
  ['@boite/core/client', 'packages/core/src/client.ts'],
]);

interface SvelteScript { content: { start: number; end: number } }
type SvelteParse = (source: string, options: { modern: true }) => { module: SvelteScript | null; instance: SvelteScript | null; fragment: unknown };
let svelteParse: SvelteParse | undefined;

/** The literal specifiers of `import(...)` in markup expressions, which Svelte parses as ESTree. */
function markupImports(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) markupImports(child, found);
  } else if (node && typeof node === 'object') {
    const { type, source } = node as { type?: unknown; source?: { type?: unknown; value?: unknown; expressions?: unknown[]; quasis?: { value: { cooked: string } }[] } };
    if (type === 'ImportExpression' && source?.type === 'Literal' && typeof source.value === 'string') found.push(source.value);
    else if (type === 'ImportExpression' && source?.type === 'TemplateLiteral' && source.expressions?.length === 0) found.push(source.quasis![0]!.value.cooked);
    for (const [key, child] of Object.entries(node)) if (key !== 'metadata') markupImports(child, found);
  }
  return found;
}

/** A component's module and instance scripts, then the dynamic imports of its markup, read with the UI's own Svelte parser. */
function svelteScripts(file: string): string {
  // Svelte measures its offsets after dropping a byte order mark.
  const source = file.replace(/^\uFEFF/, '');
  svelteParse ??= (createRequire(new URL('../../packages/ui/package.json', import.meta.url))('svelte/compiler') as { parse: SvelteParse }).parse;
  const root = svelteParse(source, { modern: true });
  const scripts = [root.module, root.instance].flatMap(script => script ? [source.slice(script.content.start, script.content.end)] : []);
  return [...scripts, ...markupImports(root.fragment).map(specifier => `import(${JSON.stringify(specifier)});`)].join('\n');
}

function runtimeImports(file: string, source: string): string[] {
  try {
    return scanner.scan(file.endsWith('.svelte') ? svelteScripts(source) : source).imports.map(imported => imported.path);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Bun's parser excludes type-only imports and includes literal dynamic imports.
 * A `.svelte` source contributes the imports of its scripts, components included,
 * and the literal dynamic imports of its markup.
 */
export function dependencyGraph(sources: Sources): Graph {
  const graph: Graph = new Map();
  for (const [file, source] of sources) {
    const dependencies: string[] = [];
    for (const specifier of runtimeImports(file, source)) {
      if (specifier.startsWith('@boite/') && !aliases.has(specifier)) {
        throw new Error(`${file}: unmapped workspace import ${specifier}; add its source to the architecture aliases`);
      }
      const path = aliases.get(specifier) ?? (specifier.startsWith('.') ? posix.normalize(`${posix.dirname(file)}/${specifier}`) : null);
      if (path === null) continue;
      const resolved = [path, `${path}.ts`, `${path}.js`, `${path}/index.ts`].find(candidate => sources.has(candidate));
      if (resolved) dependencies.push(resolved);
      else if (/\.(?:[cm]?[jt]sx?|svelte)$/.test(path) || !posix.extname(path)) {
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
