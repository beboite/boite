import { describe, expect, it, test } from 'vitest';
import type { Message, MessagePart, Turn } from '@boite/contracts';
import { countsOf, relativeTo, showsTurnFiles, turnDiffs, turnFiles, turnFileTree, turnLineCounts, TurnFileCache, type TurnDiff } from './turn-files';

function tool(name: string, input: unknown, extra: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): MessagePart {
  return { type: 'tool', toolId: `${name}-${Math.random()}`, name, input, output: null, status: 'done', ...extra };
}

const CWD = 'C:\\Users\\you\\Documents\\Boite\\2026-09-23 Letter';

test('active file summaries ignore unfinished calls, reuse diffs across text deltas and refresh deferred changes', () => {
  const edit = tool('Edit', { file_path: 'a.ts', old_string: 'old', new_string: 'new' }) as Extract<MessagePart, { type: 'tool' }>;
  const text = { type: 'text' as const, text: 'Checking' };
  const messages = [{ id: 'answer', role: 'assistant', turnId: 'turn', parts: [edit, text,
    tool('Write', { file_path: 'pending.ts', content: 'x' }, { status: 'running' })] }] as Message[];
  const turn = { id: 'turn', status: 'running' } as Turn;
  expect(showsTurnFiles(turn, false)).toBe(false);
  expect(showsTurnFiles(turn, true)).toBe(true);
  expect(showsTurnFiles({ status: 'queued' }, true)).toBe(false);
  const cache = new TurnFileCache();
  const read = () => cache.read('turn', messages, '/repo', true);
  const first = read();
  expect(first.files.map(file => file.path)).toEqual(['a.ts']);
  expect(first.diffs).toEqual([{ kind: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }]);
  text.text += ' the layout';
  expect(read()).toBe(first);
  edit.documents = [{ kind: 'diff', path: 'a.ts', oldText: '', newText: '' }];
  edit.documentsDeferred = true;
  expect(read().deferred).toEqual([{ messageId: 'answer', toolId: edit.toolId }]);
  expect(read().files[0]?.change).toBe('changed');
  expect(read().diffs).toEqual([]);
  edit.documents = [{ kind: 'diff', path: 'a.ts', oldText: 'old', newText: 'whole' }];
  delete edit.documentsDeferred;
  expect(read().deferred).toEqual([]);
  expect(read().diffs[0]?.newText).toBe('whole');
});

test('a finished turn reads its calls again only when a part is replaced or a deferred call is filled in', () => {
  const edit = tool('Edit', { file_path: 'a.ts' }, { documentsDeferred: true,
    documents: [{ kind: 'diff', path: 'a.ts', oldText: '', newText: '' }] }) as Extract<MessagePart, { type: 'tool' }>;
  const answer = { id: 'answer', role: 'assistant', turnId: 'turn', parts: [edit, tool('Write', { file_path: 'b.ts', content: 'b' })] } as Message;
  const cache = new TurnFileCache();
  const first = cache.read('turn', [answer], '/repo', false);
  expect(first.deferred).toEqual([{ messageId: 'answer', toolId: edit.toolId }]);
  expect(cache.read('turn', [answer], '/repo', false)).toBe(first);
  // `loadToolOutput` fills the deferred call in place.
  edit.documents = [{ kind: 'diff', path: 'a.ts', oldText: 'old', newText: 'new' }];
  delete edit.documentsDeferred;
  const loaded = cache.read('turn', [answer], '/repo', false);
  expect(loaded).not.toBe(first);
  expect(loaded.diffs.map(diff => diff.path)).toEqual(['a.ts', 'b.ts']);
  expect(cache.read('turn', [answer], '/repo', false)).toBe(loaded);
  answer.parts[1] = tool('Write', { file_path: 'c.ts', content: 'c' });
  expect(cache.read('turn', [answer], '/repo', false).files.map(file => file.path)).toEqual(['a.ts', 'c.ts']);
});

test('a turn end that scrolls back finds its entry; the least recently read turn goes first', () => {
  const answers = Array.from({ length: TurnFileCache.SIZE + 1 }, (_, at) =>
    ({ id: `m${at}`, role: 'assistant', turnId: `t${at}`, parts: [tool('Write', { file_path: `${at}.ts`, content: '' })] }) as Message);
  const cache = new TurnFileCache();
  const read = (at: number) => cache.read(`t${at}`, [answers[at]!], '/repo', false);
  const kept = answers.slice(0, TurnFileCache.SIZE).map((_, at) => read(at));
  expect(read(0)).toBe(kept[0]);
  read(TurnFileCache.SIZE);
  expect(read(0)).toBe(kept[0]);
  expect(read(1)).not.toBe(kept[1]);
});

describe('turnFiles', () => {
  it('reads Claude diff documents, a new file and an edit', () => {
    const files = turnFiles([
      tool('Write', { file_path: `${CWD}\\letter.md`, content: 'Dear' }, { documents: [{ kind: 'diff', path: `${CWD}\\letter.md`, oldText: '', newText: 'Dear' }] }),
      tool('Edit', { file_path: `${CWD}\\notes\\todo.txt` }, { documents: [{ kind: 'diff', path: `${CWD}\\notes\\todo.txt`, oldText: 'a', newText: 'b' }] })
    ], CWD);
    expect(files).toEqual([
      { path: `${CWD}\\letter.md`, relative: 'letter.md', absolute: `${CWD}\\letter.md`, name: 'letter.md', folder: '', change: 'created' },
      { path: `${CWD}\\notes\\todo.txt`, relative: 'notes/todo.txt', absolute: `${CWD}\\notes\\todo.txt`, name: 'todo.txt', folder: 'notes', change: 'changed' }
    ]);
  });

  it('keeps a file made then edited as new, once, at its last place in the list', () => {
    const files = turnFiles([
      tool('Write', { file_path: 'a.md', content: '' }),
      tool('Write', { file_path: 'b.md', content: '' }),
      tool('Edit', { file_path: 'a.md', old_string: 'x', new_string: 'y' })
    ], '/work');
    expect(files.map((file) => [file.relative, file.change, file.absolute])).toEqual([
      ['b.md', 'created', '/work/b.md'],
      ['a.md', 'created', '/work/a.md']
    ]);
  });

  it('reads a Codex patch and its three kinds', () => {
    const files = turnFiles([
      tool('ApplyPatch', { changes: [
        { path: '/repo/src/new.ts', kind: { type: 'add' } },
        { path: '/repo/src/old.ts', kind: { type: 'delete' } },
        { path: '/repo/README.md', kind: { type: 'update', move_path: null } }
      ] })
    ], '/repo');
    expect(files.map((file) => [file.relative, file.change])).toEqual([
      ['src/new.ts', 'created'],
      ['src/old.ts', 'deleted'],
      ['README.md', 'changed']
    ]);
  });

  it('skips failed and denied calls, reads, commands and a Codex write grant', () => {
    expect(turnFiles([
      tool('Write', { file_path: 'x.md', content: '' }, { status: 'error' }),
      tool('Write', { file_path: 'y.md', content: '' }, { status: 'denied' }),
      tool('Write', { file_path: 'pending.md', content: 'not finished' }, { status: 'running' }),
      tool('Read', { file_path: 'z.md' }),
      tool('Bash', { command: 'touch w.md' }),
      tool('ApplyPatch', { grantRoot: '/repo' })
    ], '/repo')).toEqual([]);
  });

  it('keeps a file outside the thread folder without a relative path', () => {
    const [file] = turnFiles([tool('Write', { file_path: 'D:\\elsewhere\\out.csv', content: '' })], CWD);
    expect(file).toMatchObject({ relative: null, absolute: 'D:\\elsewhere\\out.csv', folder: 'D:\\elsewhere' });
  });
});

describe('relativeTo', () => {
  it('compares Windows paths without case and refuses to climb out', () => {
    expect(relativeTo('C:\\Work', 'c:/work/src/a.ts')).toBe('src/a.ts');
    expect(relativeTo('C:\\Work', 'C:\\Workshop\\a.ts')).toBeNull();
    expect(relativeTo('/work', '../etc/passwd')).toBeNull();
    expect(relativeTo('/work', './a/b.ts')).toBe('a/b.ts');
  });
});

describe('turnFileTree', () => {
  it('keeps duplicate names in their own folders, compacts chains and preserves outside paths', () => {
    const files = turnFiles([
      tool('Write', { file_path: 'src/ui/components/view.ts' }),
      tool('Write', { file_path: 'src/core/view.ts' }),
      tool('Write', { file_path: 'README.md' }),
      tool('Write', { file_path: 'D:\\outside\\view.ts' })
    ], CWD);
    const tree = turnFileTree(files);
    const src = tree.find((node) => node.name === 'src');
    expect(src).toMatchObject({ kind: 'folder', count: 2 });
    if (src?.kind !== 'folder') throw new Error('missing src folder');
    expect(src.children.map((node) => node.name)).toEqual(['core', 'ui/components']);
    expect(src.children[1]).toMatchObject({ children: [{ file: files[0] }] });
    expect(tree.find((node) => node.name === 'D:\\outside')).toMatchObject({ count: 1, children: [{ file: files[3] }] });
    expect(tree.at(-1)).toMatchObject({ kind: 'file', file: files[2] });
    expect(turnFileTree([])).toEqual([]);
  });
});

describe('turnDiffs', () => {
  it('lists every diff a finished call drew, in order, and nothing from a failed one', () => {
    const first = { kind: 'diff' as const, path: 'a.ts', oldText: 'a', newText: 'b' };
    const second = { kind: 'diff' as const, path: 'a.ts', oldText: 'b', newText: 'c' };
    expect(turnDiffs([
      tool('Edit', {}, { documents: [first] }),
      tool('Edit', {}, { status: 'error', documents: [{ kind: 'diff', path: 'x.ts', oldText: '', newText: 'x' }] }),
      tool('Shot', {}, { documents: [{ kind: 'markdown', title: null, text: 'note' }] }),
      { type: 'text', text: 'done' },
      tool('Edit', {}, { documents: [second] })
    ])).toEqual([first, second]);
  });
});

test('lines added and removed add up per file, however the agent spelled its path, and in all', () => {
  const diff = (path: string, oldText: string, newText: string) => ({ kind: 'diff', path, oldText, newText }) as TurnDiff;
  const diffs = [
    diff('C:\\w\\src\\a.ts', 'one\ntwo\n', 'one\n2\nthree\n'),
    diff('c:/w/src/a.ts', 'x\n', ''),
    diff('src/a.ts', 'y\n', 'y\nz\n'),
    diff('b.ts', '', 'new\n'),
    diff('D:\\elsewhere\\c.ts', '', 'far\n')
  ];
  const { total, byPath } = turnLineCounts(diffs, 'C:\\w');
  expect(total).toEqual({ added: 5, removed: 2 });
  // The rows the card draws, one per file, each with the counts of every spelling.
  const files = turnFiles(diffs.map((document) => ({ type: 'tool', toolId: document.path, name: 'Edit', input: {}, status: 'done', documents: [document] }) as MessagePart), 'C:\\w');
  expect(files.map((file) => [file.relative ?? file.path, countsOf(byPath, file)])).toEqual([
    ['src/a.ts', { added: 3, removed: 2 }],
    ['b.ts', { added: 1, removed: 0 }],
    ['D:\\elsewhere\\c.ts', { added: 1, removed: 0 }]
  ]);
  expect(countsOf(byPath, { path: 'd.ts', relative: 'd.ts', absolute: null, name: '', folder: '', change: 'changed' })).toBeNull();
});
