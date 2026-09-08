import { expect, test } from 'vitest';
import { diffCounts, diffRows } from './diff';

test('a changed middle line is one remove and one add between the context lines', () => {
  const rows = diffRows('one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  expect(rows.map((row) => row.kind)).toEqual(['context', 'remove', 'add', 'context']);
  expect(rows[1]).toEqual({ kind: 'remove', text: 'two', oldLine: 2 });
  expect(rows[2]).toEqual({ kind: 'add', text: 'TWO', newLine: 2 });
  expect(diffCounts(rows)).toEqual({ added: 1, removed: 1 });
});

test('a pure addition is one add row, the rest context', () => {
  const rows = diffRows('one\ntwo\n', 'one\ntwo\nthree\n');
  expect(rows.map((row) => row.kind)).toEqual(['context', 'context', 'add']);
  expect(rows[2]).toEqual({ kind: 'add', text: 'three', newLine: 3 });
  expect(diffCounts(rows)).toEqual({ added: 1, removed: 0 });
});

test('two identical texts give no row at all', () => {
  expect(diffRows('one\ntwo\nthree\n', 'one\ntwo\nthree\n')).toEqual([]);
  expect(diffRows('', '')).toEqual([]);
});

test('unchanged lines away from a change are folded into one gap row', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const after = before.replace('line 10', 'line ten');
  const rows = diffRows(before, after);

  // Three lines of context on each side of the one change, and one gap row for
  // each of the two runs folded away.
  expect(rows.filter((row) => row.kind === 'gap')).toEqual([
    { kind: 'gap', hidden: 7 },
    { kind: 'gap', hidden: 6 },
  ]);
  expect(rows.filter((row) => row.kind === 'context')).toHaveLength(6);
  expect(diffCounts(rows)).toEqual({ added: 1, removed: 1 });
});

test('a new file is every line added, with no removed one', () => {
  const rows = diffRows('', 'one\ntwo\n');
  expect(rows.map((row) => row.kind)).toEqual(['add', 'add']);
  expect(diffCounts(rows)).toEqual({ added: 2, removed: 0 });
});
