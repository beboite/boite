import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate, parse, references, splitContracts, SRC, type Table } from './split-contracts';

const table: Table = {
  anchors: [['ThreadId', 'ids'], ['Thread', 'threads'], ['Settings', 'settings'], ['RpcMethods', 'index']],
  namespaces: { threads: 'threads', thread: 'threads', settings: 'settings' },
};
const single = (extra: { thread?: string; methods?: string } = {}) => `import type { Extra } from './extra';
export * from './extra';

/** The contract. */
export const PROTOCOL_VERSION = 2 as const;

export type ThreadId = string;

export interface Thread {
  id: ThreadId;
  extra: Extra;
  settings: Settings;
}
${extra.thread ?? ''}
export const THREAD_MAX = 10;

export interface Settings {
  theme: string;
  protocol: typeof PROTOCOL_VERSION;
}

export interface RpcMethods {
  'threads.get': { params: { id: ThreadId }; result: Thread };
  /** Owner only. */
  'settings.get': { params: Record<string, never>; result: Settings };
${extra.methods ?? ''}}

export type RpcMethodName = keyof RpcMethods;

export interface RpcEvents {
  'thread.changed': { id: ThreadId; max: typeof THREAD_MAX };
}
`;

const aliased = (source: string) => source.replace("import type { Extra } from './extra';", "import type { Extra as Bonus } from './extra';").replace('extra: Extra;', 'extra: Bonus;');
const titled = (source: string) => source.replace('id: ThreadId;', 'id: ThreadId;\n  title: string;');

describe('splitContracts', () => {
  test('puts each declaration in its anchor file and each member in its namespace file', () => {
    const files = splitContracts(single(), table);
    expect([...files.keys()].sort()).toEqual(['ids.ts', 'index.ts', 'settings.ts', 'threads.ts']);
    expect(files.get('threads.ts')).toStartWith("import type { Extra } from './extra';\nimport type { ThreadId } from './ids';\nimport type { Settings } from './settings';\n\nexport interface Thread {");
    expect(files.get('threads.ts')).toContain("export interface ThreadsRpcEvents {\n  'thread.changed': { id: ThreadId; max: typeof THREAD_MAX };\n}");
    expect(files.get('settings.ts')).toContain("import type { PROTOCOL_VERSION } from './index';");
    expect(files.get('settings.ts')).toContain("export interface SettingsRpcMethods {\n  /** Owner only. */\n  'settings.get'");
    const index = files.get('index.ts')!;
    expect(index).toContain("export * from './extra';\nimport type { SettingsRpcMethods } from './settings';");
    expect(index).toContain('export interface RpcMethods extends\n  ThreadsRpcMethods,\n  SettingsRpcMethods {}');
    expect(index).not.toContain('import type { Extra }');
  });

  test('keeps an aliased import under its exported name', () => {
    expect(splitContracts(aliased(single()), table).get('threads.ts')).toStartWith("import type { Extra as Bonus } from './extra';");
  });

  test('refuses a single file that lost an anchor', () => {
    expect(() => splitContracts(single().replace('interface Settings', 'interface Prefs'), table)).toThrow('anchors not declared: Settings');
  });

  test('reads names, not keys, parameters or declared names', () => {
    const [statement] = parse('a.ts', 'export function f(id: ThreadId, { a }: Opts = DEFAULTS): Out { const local = x.prop; return { key: local } as Cast; }');
    expect([...references(statement!).entries()].sort()).toEqual([['Cast', true], ['DEFAULTS', false], ['Opts', true], ['Out', true], ['ThreadId', true], ['local', false], ['x', false]]);
  });
});

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function diverge(branch: string, mainEdit?: (files: Map<string, string>) => void) {
  dir = mkdtempSync(join(tmpdir(), 'split-contracts-'));
  const git = (...args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout.trim();
  const put = (files: Map<string, string>) => {
    mkdirSync(join(dir, SRC), { recursive: true });
    for (const [name, text] of files) writeFileSync(join(dir, SRC, name), text);
  };
  git('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']] as const) git('config', key, value);
  put(new Map([['index.ts', single()], ['extra.ts', 'export interface Extra { a: 1 }\n']]));
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  put(new Map([['index.ts', branch]]));
  git('commit', '-qam', 'branch');
  git('checkout', '-q', 'main');
  const files = splitContracts(single(), table);
  mainEdit?.(files);
  put(files);
  git('add', '-A');
  git('commit', '-qm', 'split');
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-edit', 'main');
  return (name: string) => readFileSync(join(dir, SRC, name), 'utf8');
}

describe('migrate', () => {
  test('replays a new method and its type onto the domain main kept editing, imports included', () => {
    const read = diverge(
      single({ thread: '\nexport interface ThreadPage { thread: Thread; settings: Settings }\n', methods: "  'threads.page': { params: { id: ThreadId }; result: ThreadPage };\n" }),
      (files) => files.set('settings.ts', files.get('settings.ts')!.replace('theme: string;', 'theme: string;\n  density: number;')),
    );
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD', table);
    expect(result.conflicts).toEqual([]);
    expect(result.written).toEqual([`${SRC}/threads.ts`]);
    expect(read('threads.ts')).toContain("import type { Settings } from './settings';");
    expect(read('threads.ts')).toContain('export interface ThreadPage { thread: Thread; settings: Settings }');
    expect(read('threads.ts')).toContain("  'threads.page': { params: { id: ThreadId }; result: ThreadPage };\n}");
    expect(read('settings.ts')).toContain('density: number;');
    expect(read('index.ts')).not.toContain('<<<<<<<');
  });

  test('keeps the imports of a clean domain that reads a type of a conflicted one', () => {
    const read = diverge(
      titled(single()).replace('theme: string;', 'theme: number;'),
      (files) => files.set('settings.ts', files.get('settings.ts')!.replace('theme: string;', 'theme: boolean;')),
    );
    const result = migrate(dir, 'HEAD', 'MERGE_HEAD', table);
    expect(result.conflicts).toEqual([`${SRC}/settings.ts`]);
    expect(result.written).toEqual([`${SRC}/threads.ts`]);
    expect(read('threads.ts')).toContain("import type { Settings } from './settings';");
  });

  test('replays the branch edits of a file that imports under an alias', () => {
    const read = diverge(titled(aliased(single())));
    expect(migrate(dir, 'HEAD', 'MERGE_HEAD', table).conflicts).toEqual([]);
    expect(read('threads.ts')).toStartWith("import type { Extra as Bonus } from './extra';");
  });

  test('leaves conflict markers where both sides changed the same line', () => {
    const read = diverge(single().replace('theme: string;', 'theme: number;'), (files) => files.set('settings.ts', files.get('settings.ts')!.replace('theme: string;', 'theme: boolean;')));
    expect(migrate(dir, 'HEAD', 'MERGE_HEAD', table).conflicts).toEqual([`${SRC}/settings.ts`]);
    expect(read('settings.ts')).toMatch(/<<<<<<< HEAD\n {2}theme: number;\n=======\n {2}theme: boolean;\n>>>>>>> main/);
  });
});
