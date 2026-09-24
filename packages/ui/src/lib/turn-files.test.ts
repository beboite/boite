import { describe, expect, it } from 'vitest';
import type { MessagePart } from '@boite/contracts';
import { relativeTo, turnFiles } from './turn-files';

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
