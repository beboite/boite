/**
 * `packages/contracts/src/index.ts` was one file of every RPC method, event and
 * shared type, so nearly every pull request edited it. It is now one file per
 * domain beside it (`threads.ts`, `providers.ts`), behind an index that
 * re-exports them all and composes `RpcMethods` and `RpcEvents` from each
 * domain's `<Domain>RpcMethods` and `<Domain>RpcEvents`.
 *
 * Run on a branch cut before the split once `git merge origin/main` stopped
 * (or after the merge commit):
 *
 *   bun scripts/migrate/split-contracts.ts
 *
 * It splits the merge base and the branch versions of `index.ts` with the
 * codemod that made the split, then replays each domain's change onto main's
 * file with `git merge-file` and rewrites the imports of each file it touched.
 * A file both sides changed on the same lines keeps conflict markers and is
 * listed, like any merge conflict.
 *
 * `bun scripts/migrate/split-contracts.ts --split` reruns the codemod on the
 * working tree of a tree that still has the single file.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { exists, git, mergeFile, mergeSides, show } from './git';

type Node = { type: string; start: number; end: number; [key: string]: any };
export const SRC = 'packages/contracts/src';
const ROOT = join(import.meta.dir, '..', '..');
const { parseSync } = await import(createRequire(join(ROOT, 'packages/ui/package.json')).resolve('vite'));

/**
 * Each top-level declaration goes to the file of the last anchor at or above it
 * in the single file, so a declaration a branch adds lands beside its
 * neighbours. Imports and re-exports stay in the index.
 */
export const ANCHORS: ReadonlyArray<readonly [declaration: string, file: string]> = [
  ['ProjectId', 'ids'],
  ['Protocol', 'providers'],
  ['AccountStatus', 'accounts'],
  ['PLUGIN_MANIFEST_FILE', 'plugins'],
  ['Account', 'accounts'],
  ['Project', 'projects'],
  ['PermissionMode', 'threads'],
  ['Usage', 'usage'],
  ['TurnStatus', 'turns'],
  ['MessageRole', 'messages'],
  ['AgentCommand', 'threads'],
  ['PermissionRequest', 'permissions'],
  ['QuestionOption', 'questions'],
  ['ProcessRecord', 'trace'],
  ['SchedulerState', 'scheduler'],
  ['TelemetryState', 'settings'],
  ['SubscriptionProxy', 'subscription-proxy'],
  ['WorktreeStorage', 'settings'],
  ['KEYBINDING_COMMANDS', 'keybindings'],
  ['ImportableSession', 'imports'],
  ['Keybindings', 'keybindings'],
  ['Channel', 'core'],
  ['Principal', 'agent-door'],
  ['PanelSurface', 'panel'],
  ['Todo', 'todos'],
  ['GitChangeStatus', 'git'],
  ['FileEntry', 'files'],
  ['PairingRole', 'pairing'],
  ['SpeechEngine', 'speech'],
  ['CoordinationMode', 'coordination'],
  ['GroupCore', 'group'],
  ['CoordinationView', 'coordination'],
  ['DelegationProfile', 'delegation'],
  ['BrainConfig', 'brain'],
  ['HookOutcome', 'hooks'],
  ['MAX_THREAD_TERMINALS', 'terminals'],
  ['ServerUpdateStatus', 'core'],
  ['RpcMethods', 'index'],
  ['RpcRequest', 'wire'],
  ['supportsSideQuestions', 'providers'],
  ['DISPLAY_IMAGE_MAX', 'messages'],
];

/**
 * The file of a method or an event, by the namespace before its first dot. A
 * namespace missing here follows the member above it.
 */
export const NAMESPACES: Readonly<Record<string, string>> = {
  account: 'accounts', accounts: 'accounts', quotas: 'accounts',
  agent: 'agent-door',
  artifacts: 'messages', attachments: 'messages', drafts: 'messages', message: 'messages', messages: 'messages', push: 'messages',
  brain: 'brain',
  collaboration: 'coordination', resident: 'coordination',
  core: 'core',
  delegation: 'delegation',
  files: 'files',
  git: 'git', worktrees: 'git',
  group: 'group',
  hooks: 'hooks',
  imports: 'imports', sessions: 'imports',
  journal: 'threads', thread: 'threads', threads: 'threads',
  keybindings: 'keybindings',
  firewall: 'pairing', pairing: 'pairing', tailscale: 'pairing',
  panel: 'panel', ui: 'panel',
  permission: 'permissions', permissions: 'permissions',
  plugins: 'plugins',
  project: 'projects', projects: 'projects',
  providers: 'providers',
  question: 'questions', questions: 'questions',
  scheduler: 'scheduler',
  settings: 'settings', telemetry: 'settings',
  speech: 'speech',
  subscriptionProxy: 'subscription-proxy',
  terminal: 'terminals', terminals: 'terminals',
  todos: 'todos',
  process: 'trace', resources: 'trace', trace: 'trace',
  turn: 'turns', turns: 'turns',
  usage: 'usage',
};

const MAPS = ['RpcMethods', 'RpcEvents'] as const;
const pascal = (file: string) => file.replace(/(^|-)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const MODULE_STATEMENTS = new Set(['ImportDeclaration', 'ExportAllDeclaration']);
const isModuleStatement = (s: Node) => MODULE_STATEMENTS.has(s.type) || (s.type === 'ExportNamedDeclaration' && s.source);
const TYPE_DECLARATIONS = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration']);
/** TypeScript nodes whose `expression` is a value, the rest of them a type. */
const VALUE_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression']);
const VALUE_TS = new Set(['TSEnumDeclaration', 'TSEnumMember', 'TSModuleDeclaration', 'TSExportAssignment', 'TSImportEqualsDeclaration']);

export function parse(file: string, source: string): Node[] {
  const parsed = parseSync(file, source, { lang: 'ts' });
  if (parsed.errors.length) throw new Error(`${file}: ${parsed.errors[0].message}`);
  return parsed.program.body;
}

function declarationOf(statement: Node): Node | undefined {
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') return statement.declaration ?? undefined;
  return statement.type.endsWith('Declaration') && !isModuleStatement(statement) ? statement : undefined;
}

/** The names a top-level statement declares, each with whether it is only a type. */
export function declared(statement: Node): Array<{ name: string; type: boolean }> {
  const declaration = declarationOf(statement);
  if (!declaration) return [];
  if (declaration.type === 'VariableDeclaration') {
    return declaration.declarations.flatMap((d: Node) => (d.id.type === 'Identifier' ? [{ name: d.id.name, type: false }] : []));
  }
  return declaration.id?.name ? [{ name: declaration.id.name, type: TYPE_DECLARATIONS.has(declaration.type) }] : [];
}

/**
 * The identifiers a node reads, each with whether every read is in a type.
 * Declared names, property keys and parameter names are not reads.
 */
export function references(node: Node, found = new Map<string, boolean>(), inType = false): Map<string, boolean> {
  const visit = (child: unknown, type: boolean) => {
    if (Array.isArray(child)) for (const item of child) visit(item, type);
    else if (child && typeof child === 'object' && typeof (child as Node).type === 'string') references(child as Node, found, type);
  };
  if (node.type === 'Identifier') {
    found.set(node.name, (found.get(node.name) ?? true) && inType);
    return found;
  }
  const type = inType || (node.type.startsWith('TS') && !VALUE_WRAPPERS.has(node.type) && !VALUE_TS.has(node.type));
  const binding = (pattern: Node | null | undefined) => {
    if (!pattern) return;
    if (pattern.type === 'Identifier') visit(pattern.typeAnnotation, true);
    else if (pattern.type === 'AssignmentPattern') { binding(pattern.left); visit(pattern.right, type); }
    else if (pattern.type === 'RestElement') { binding(pattern.argument); visit(pattern.typeAnnotation, true); }
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        if (property.type === 'RestElement') binding(property);
        else { if (property.computed) visit(property.key, type); binding(property.value); }
      }
      visit(pattern.typeAnnotation, true);
    } else if (pattern.type === 'ArrayPattern') { for (const element of pattern.elements) binding(element); visit(pattern.typeAnnotation, true); }
    else if (pattern.type === 'TSParameterProperty') binding(pattern.parameter);
    else visit(pattern, type);
  };
  for (const [key, child] of Object.entries(node)) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    if (key === 'id' && /Declaration$|Declarator$|EnumMember$/.test(node.type)) {
      if (node.type === 'VariableDeclarator') binding(child as Node);
      continue;
    }
    if (key === 'key' && !node.computed) continue;
    if (key === 'property' && node.type === 'MemberExpression' && !node.computed) continue;
    if (key === 'right' && node.type === 'TSQualifiedName') continue;
    if (key === 'name' && node.type === 'TSTypeParameter') continue;
    if (key === 'label') continue;
    if (key === 'params' && Array.isArray(child) && node.type !== 'TSTypeParameterInstantiation' && node.type !== 'TSTypeParameterDeclaration') {
      for (const param of child) binding(param as Node);
      continue;
    }
    if (key === 'parameters' && Array.isArray(child)) { for (const param of child) binding(param as Node); continue; }
    if (key === 'param' && node.type === 'CatchClause') { binding(child as Node); continue; }
    if (key === 'expression' && VALUE_WRAPPERS.has(node.type)) { visit(child, inType); continue; }
    visit(child, type);
  }
  return found;
}

/** Where a name comes from; `imported` is the name the module exports when the import renamed it. */
export interface Symbol { module: string; type: boolean; imported?: string }

/** The symbol an import specifier binds, keyed by its local name. */
export function importedSymbol(statement: Node, specifier: Node): Symbol {
  if (specifier.type === 'ImportNamespaceSpecifier') throw new Error(`import * as ${specifier.local.name} from '${statement.source.value}': name the imports instead`);
  const imported = specifier.type === 'ImportDefaultSpecifier' ? 'default' : (specifier.imported.name ?? specifier.imported.value);
  return {
    module: statement.source.value,
    type: statement.importKind === 'type' || specifier.importKind === 'type',
    ...(imported === specifier.local.name ? {} : { imported }),
  };
}

/** One `import type` line and one `import` line per module, sorted, for the names `reads` takes from elsewhere. */
export function importHeader(self: string, reads: Map<string, boolean>, symbols: Map<string, Symbol>): string {
  const byModule = new Map<string, { types: string[]; values: string[] }>();
  for (const [name, onlyType] of [...reads].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const symbol = symbols.get(name);
    if (!symbol || symbol.module === self) continue;
    const entry = byModule.get(symbol.module) ?? { types: [], values: [] };
    (symbol.type || onlyType ? entry.types : entry.values).push(symbol.imported ? `${symbol.imported} as ${name}` : name);
    byModule.set(symbol.module, entry);
  }
  const lines: string[] = [];
  for (const module of [...byModule.keys()].sort()) {
    const { types, values } = byModule.get(module)!;
    if (types.length) lines.push(`import type { ${types.join(', ')} } from '${module}';`);
    if (values.length) lines.push(`import { ${values.join(', ')} } from '${module}';`);
  }
  return lines.join('\n');
}

const withHeader = (header: string, body: string) => `${header ? `${header}\n\n` : ''}${body.replace(/^\s*\n/, '')}`;

interface Piece { text: string; nodes: Node[] }

/** The files the split writes, by name under `src/`, from the single `index.ts`. */
export interface Table {
  anchors: ReadonlyArray<readonly [string, string]>;
  namespaces: Readonly<Record<string, string>>;
}
const TABLE: Table = { anchors: ANCHORS, namespaces: NAMESPACES };

export function splitContracts(source: string, table: Table = TABLE): Map<string, string> {
  const statements = parse('index.ts', source);
  const anchors = new Map(table.anchors);
  const missing = table.anchors.filter(([name]) => !statements.some((s) => declared(s).some((d) => d.name === name)));
  if (missing.length) throw new Error(`index.ts: anchors not declared: ${missing.map(([name]) => name).join(', ')}; restore them or split by hand`);

  const parts = new Map<string, Piece[]>();
  const members = new Map<string, Map<(typeof MAPS)[number], string[]>>();
  const add = (file: string, piece: Piece) => parts.set(file, [...(parts.get(file) ?? []), piece]);
  const order: string[] = [];
  const top: Piece[] = [];
  const index: Array<Piece | { map: (typeof MAPS)[number]; head: string; extends: string[] }> = [];
  let file = 'index';
  let leading = true;
  let previous = 0;
  for (const statement of statements) {
    const text = source.slice(previous, statement.end);
    previous = statement.end;
    const names = declared(statement);
    const anchor = names.map((d) => anchors.get(d.name)).find(Boolean);
    if (anchor) file = anchor;
    if (isModuleStatement(statement)) {
      (leading ? top : index).push({ text, nodes: [statement] });
      continue;
    }
    leading = false;
    const map = MAPS.find((name) => names.some((d) => d.name === name));
    if (map) {
      const declaration = declarationOf(statement)!;
      const body = declaration.body.body as Node[];
      let at = declaration.body.start + 1;
      let owner = 'index';
      for (const member of body) {
        const chunk = source.slice(at, member.end).replace(/^[ \t]*\n/, '');
        at = member.end;
        const key = member.key?.value ?? member.key?.name ?? '';
        owner = table.namespaces[String(key).split('.')[0]!] ?? owner;
        if (owner === 'index') throw new Error(`index.ts: ${map} member ${key} has no namespace file; add it to NAMESPACES`);
        const byMap = members.get(owner) ?? new Map();
        byMap.set(map, [...(byMap.get(map) ?? []), chunk]);
        members.set(owner, byMap);
        if (!order.includes(owner)) order.push(owner);
      }
      const tail = source.slice(at, declaration.body.end - 1).trim();
      if (tail) throw new Error(`index.ts: text after the last ${map} member: ${tail.slice(0, 80)}`);
      index.push({
        map,
        head: text.slice(0, text.length - (statement.end - statement.start)),
        extends: (declaration.extends as Node[]).map((h) => source.slice(h.start, h.end)),
      });
      continue;
    }
    if (file === 'index') index.push({ text, nodes: [statement] });
    else {
      add(file, { text, nodes: [statement] });
      if (!order.includes(file)) order.push(file);
    }
  }
  const files = [...parts.keys(), ...members.keys()].filter((f, i, all) => all.indexOf(f) === i).sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // Every name a split file may import: the declarations, the domain maps, and what the index imported.
  const symbols = new Map<string, Symbol>();
  for (const piece of top.concat(index.filter((p): p is Piece => 'text' in p))) {
    const statement = piece.nodes[0]!;
    if (statement.type !== 'ImportDeclaration') continue;
    for (const specifier of statement.specifiers) symbols.set(specifier.local.name, importedSymbol(statement, specifier));
  }
  for (const [name, pieces] of parts) for (const piece of pieces) for (const d of piece.nodes.flatMap(declared)) symbols.set(d.name, { module: `./${name}`, type: d.type });
  for (const [name, byMap] of members) for (const map of byMap.keys()) symbols.set(`${pascal(name)}${map}`, { module: `./${name}`, type: true });
  for (const map of MAPS) symbols.set(map, { module: './index', type: true });
  for (const piece of index) {
    if ('text' in piece) for (const d of piece.nodes.flatMap(declared)) symbols.set(d.name, { module: './index', type: d.type });
  }

  const out = new Map<string, string>();
  for (const name of files) {
    const reads = new Map<string, boolean>();
    for (const piece of parts.get(name) ?? []) for (const node of piece.nodes) references(node, reads);
    const chunks = (parts.get(name) ?? []).map((piece) => piece.text);
    const body = chunks.length ? `${chunks.join('').replace(/^\s*\n/, '')}\n` : '';
    const maps = [...(members.get(name) ?? new Map<string, string[]>())].map(([map, list]) => {
      const text = `export interface ${pascal(name)}${map} {\n${list.join('\n')}\n}\n`;
      for (const statement of parse('map.ts', text)) references(statement, reads);
      return text;
    });
    out.set(`${name}.ts`, withHeader(importHeader(`./${name}`, reads, symbols), [body, ...maps].filter(Boolean).join('\n')));
  }

  // The index: its own imports and re-exports, every split file re-exported, the two maps composed.
  const reads = new Map<string, boolean>();
  const composed: string[] = [];
  for (const piece of index) {
    if ('text' in piece) {
      if (!isModuleStatement(piece.nodes[0]!)) for (const node of piece.nodes) references(node, reads);
      continue;
    }
    for (const parent of piece.extends) reads.set(parent.replace(/<.*$/, ''), true);
    for (const name of files) if (members.get(name)?.has(piece.map)) reads.set(`${pascal(name)}${piece.map}`, true);
  }
  const used = (piece: Piece) => {
    const statement = piece.nodes[0]!;
    return statement.type !== 'ImportDeclaration' || statement.specifiers.some((s: Node) => reads.has(s.local.name));
  };
  for (const piece of index) {
    if ('text' in piece) {
      if (used(piece)) composed.push(piece.text);
      continue;
    }
    const parents = [...piece.extends, ...files.filter((name) => members.get(name)?.has(piece.map)).map((name) => `${pascal(name)}${piece.map}`)];
    composed.push(`${piece.head}export interface ${piece.map} extends\n${parents.map((p) => `  ${p}`).join(',\n')} {}`);
  }
  const local = new Map([...symbols].filter(([, symbol]) => symbol.module.startsWith('./') && files.includes(symbol.module.slice(2))));
  const header = importHeader('./index', reads, local);
  const reexports = files.map((name) => `export * from './${name}';`).join('\n');
  const leadingText = top.filter(used).map((piece) => piece.text).join('').replace(/^\s*\n/, '');
  out.set('index.ts', `${[leadingText, header, reexports].filter(Boolean).join('\n')}${composed.join('')}\n`);
  return out;
}

/** The leading imports of a split file, and the rest. */
export function splitHeader(source: string): { header: string; body: string } {
  const statements = parse('part.ts', source);
  let end = 0;
  for (const statement of statements) {
    if (statement.type !== 'ImportDeclaration') break;
    end = statement.end;
  }
  return { header: source.slice(0, end), body: source.slice(end).replace(/^\s*\n/, '') };
}

export interface MigrationResult {
  written: string[];
  conflicts: string[];
}

/**
 * Replays the branch's contract edits (`base` to `ours`, single `index.ts`)
 * onto main's split files (`theirs`) in the working tree of `cwd`.
 */
export function migrate(cwd: string, ours: string, theirs: string, table: Table = TABLE): MigrationResult {
  const result: MigrationResult = { written: [], conflicts: [] };
  const base = git(cwd, ['merge-base', ours, theirs]).stdout.trim();
  if (!base) throw new Error(`no merge base between ${ours} and ${theirs}`);
  const split = (ref: string) => {
    const source = show(cwd, ref, `${SRC}/index.ts`);
    if (source === undefined) throw new Error(`${ref} has no ${SRC}/index.ts`);
    return splitContracts(source, table);
  };
  const before = split(base);
  const after = split(ours);
  const mainFiles = new Map<string, string>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const text = show(cwd, theirs, `${SRC}/${name}`);
    if (text !== undefined) mainFiles.set(name, text);
  }

  // Bodies first: each changed file's change replayed on main's, imports aside.
  const final = new Map(mainFiles);
  const clean = new Set<string>();
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name) ?? '';
    const now = after.get(name) ?? '';
    if (was === now) continue;
    const main = mainFiles.get(name);
    if (name === 'index.ts' || main === undefined) {
      const merged = mergeFile(now, was, main ?? '');
      final.set(name, merged.text);
      (merged.conflict ? result.conflicts : result.written).push(`${SRC}/${name}`);
      continue;
    }
    const merged = mergeFile(splitHeader(now).body, splitHeader(was).body, splitHeader(main).body);
    if (merged.conflict) {
      final.set(name, withHeader(splitHeader(main).header, merged.text));
      result.conflicts.push(`${SRC}/${name}`);
    } else {
      final.set(name, merged.text);
      clean.add(name);
    }
  }

  // Then the imports of every file the branch changed, from what each file now declares.
  const symbols = new Map<string, Symbol>();
  const external = (text: string) => {
    for (const statement of parse('part.ts', splitHeader(text).header)) {
      for (const specifier of statement.specifiers ?? []) {
        if (statement.source.value.startsWith('./') && final.has(`${statement.source.value.slice(2).replace(/\.ts$/, '')}.ts`)) continue;
        symbols.set(specifier.local.name, importedSymbol(statement, specifier));
      }
    }
  };
  for (const [name, text] of [...after, ...mainFiles]) if (name !== 'index.ts') external(text);
  // A conflicted file cannot be parsed; its names belong to it on both sides, so they come from those.
  const sources = [...final].flatMap(([name, text]): Array<[string, string]> => {
    if (!result.conflicts.includes(`${SRC}/${name}`)) return [[name, clean.has(name) || name === 'index.ts' ? text : splitHeader(text).body]];
    return [mainFiles.get(name), after.get(name)].flatMap((side) => (side === undefined ? [] : [[name, splitHeader(side).body] as [string, string]]));
  });
  for (const [name, body] of sources) {
    const module = `./${name.slice(0, -3)}`;
    for (const statement of parse(name, body)) {
      for (const d of declared(statement)) symbols.set(d.name, { module, type: d.type });
    }
  }
  for (const map of MAPS) symbols.set(map, { module: './index', type: true });
  for (const name of clean) {
    const body = final.get(name)!;
    const reads = new Map<string, boolean>();
    for (const statement of parse(name, body)) references(statement, reads);
    final.set(name, withHeader(importHeader(`./${name.slice(0, -3)}`, reads, symbols), body));
    result.written.push(`${SRC}/${name}`);
  }

  // The index is written even unchanged: `git merge` left its conflict markers there.
  for (const name of [...clean, 'index.ts']) {
    const text = final.get(name);
    if (text === undefined || (name !== 'index.ts' && text === mainFiles.get(name))) continue;
    mkdirSync(join(cwd, SRC), { recursive: true });
    writeFileSync(join(cwd, SRC, name), text);
  }
  for (const path of result.conflicts) writeFileSync(join(cwd, path), final.get(path.slice(SRC.length + 1))!);
  return result;
}

function main() {
  const cwd = git(process.cwd(), ['rev-parse', '--show-toplevel']).stdout.trim() || process.cwd();
  if (process.argv.includes('--split')) {
    const files = splitContracts(readFileSync(join(cwd, SRC, 'index.ts'), 'utf8').replaceAll('\r\n', '\n'));
    for (const [name, text] of files) writeFileSync(join(cwd, SRC, name), text);
    console.log(`${files.size - 1} domain files`);
    return;
  }
  const sides = mergeSides(cwd);
  if (!sides) {
    console.error('Merge main first: git merge origin/main, then rerun this command.');
    process.exit(2);
  }
  const marker = `${SRC}/ids.ts`;
  if (exists(cwd, sides.ours, marker)) {
    console.log('The branch already has the split contracts; nothing to migrate.');
    return;
  }
  if (!exists(cwd, sides.theirs, marker)) {
    console.error(`${sides.theirs} does not have the split contracts; merge a main that has them.`);
    process.exit(2);
  }
  const result = migrate(cwd, sides.ours, sides.theirs);
  if (result.written.length) git(cwd, ['add', '--', ...result.written]);
  if (sides.merging && !result.conflicts.includes(`${SRC}/index.ts`)) git(cwd, ['add', '--', `${SRC}/index.ts`]);
  for (const path of result.written) console.log(`merged   ${path}`);
  for (const conflict of result.conflicts) console.error(`conflict ${conflict}`);
  if (!sides.merging) console.log('Files are staged; commit them on top of the merge.');
  if (result.conflicts.length) process.exit(1);
}

if (import.meta.main) main();
