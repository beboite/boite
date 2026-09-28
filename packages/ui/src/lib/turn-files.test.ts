import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@boite/contracts';
import { relativeTo, turnDiffs, turnFiles, turnFileTree } from './turn-files';

function tool(name: string, input: unknown, extra: Partial<Extract<MessagePart, { type: 'tool' }>> = {}): MessagePart {
  return { type: 'tool', toolId: `${name}-${Math.random()}`, name, input, output: null, status: 'done', ...extra };
}

const CWD = 'C:\\Users\\you\\Documents\\Boite\\2026-09-23 Letter';

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
