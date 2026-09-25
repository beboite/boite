import { expect, test } from 'vitest';
import { MAX_EDITS, diffCounts, diffRows } from './diff';

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

test('two edits far apart stay aligned, with the lines between them folded', () => {
  const before = Array.from({ length: 1200 }, (_, index) => `line ${index}`);
  const after = [...before];
  after[5] = 'changed top';
  after[1195] = 'changed bottom';
  const rows = diffRows(before.join('\n'), after.join('\n'));

  expect(diffCounts(rows)).toEqual({ added: 2, removed: 2 });
  expect(rows.filter((row) => row.kind === 'gap')).toEqual([
    { kind: 'gap', hidden: 2 },
    { kind: 'gap', hidden: 1183 },
    { kind: 'gap', hidden: 1 },
  ]);
  expect(rows.find((row) => row.kind === 'add' && row.text === 'changed bottom')).toEqual({
    kind: 'add',
    text: 'changed bottom',
    newLine: 1196,
  });
});

test('a 4,000-line file with a tenth of its lines changed is still aligned', () => {
  const before = Array.from({ length: 4000 }, (_, index) => `line ${index}`);
  const after = before.map((line, index) => (index % 10 === 1 ? `${line} changed` : line));
  const counts = diffCounts(diffRows(before.join('\n'), after.join('\n')));
  expect(counts).toEqual({ added: 400, removed: 400 });
});

test(`a middle more than ${MAX_EDITS} edits apart is shown removed then added`, () => {
  const size = MAX_EDITS + 2;
  const before = Array.from({ length: size }, (_, index) => `line ${index}`);
  const after = before.map((line, index) => (index % 2 ? `${line} changed` : line));
  const counts = diffCounts(diffRows(before.join('\n'), after.join('\n')));
  // Aligned, the odd lines would be MAX_EDITS + 2 edits, past the limit, so the
  // whole middle after the shared first line goes out and comes back in.
  expect(counts).toEqual({ added: size - 1, removed: size - 1 });
});

test('the same lines in reverse order run the search to its limit, then go unaligned', () => {
  const before = Array.from({ length: MAX_EDITS }, (_, index) => `line ${index}`);
  const after = [...before].reverse();
  // Every line exists on both sides, so only the search itself finds that the
  // two share one line and are nearly 2 * MAX_EDITS edits apart.
  expect(diffCounts(diffRows(before.join('\n'), after.join('\n')))).toEqual({
    added: MAX_EDITS,
    removed: MAX_EDITS,
  });
});

/** The length of the longest common subsequence, by the plain table. */
function lcsLength(a: string[], b: string[]): number {
  let previous = new Array<number>(b.length + 1).fill(0);
  for (const line of a) {
    const next = [0];
    b.forEach((other, j) => next.push(line === other ? (previous[j] ?? 0) + 1 : Math.max(previous[j + 1] ?? 0, next[j] ?? 0)));
    previous = next;
  }
  return previous[b.length] ?? 0;
}

test('random edits give a shortest diff whose rows point at the right lines', () => {
  let seed = 7;
  const random = (bound: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % bound;
  };
  for (let round = 0; round < 300; round += 1) {
    const before = Array.from({ length: random(40) }, () => `l${random(6)}`);
    const after = Array.from({ length: random(40) }, () => `l${random(6)}`);
    const rows = diffRows(before.join('\n'), after.join('\n'));
    const { added, removed } = diffCounts(rows);
    const common = lcsLength(before, after);
    expect({ added, removed }).toEqual({ added: after.length - common, removed: before.length - common });
    for (const row of rows) {
      if (row.kind === 'add') expect(after[row.newLine - 1]).toBe(row.text);
      if (row.kind === 'remove') expect(before[row.oldLine - 1]).toBe(row.text);
      if (row.kind === 'context') {
        expect(before[row.oldLine - 1]).toBe(row.text);
        expect(after[row.newLine - 1]).toBe(row.text);
      }
    }
  }
});
