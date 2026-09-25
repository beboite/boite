/**
 * The line diff a `diff` tool document is drawn from. No dependency: the whole
 * job is an LCS over lines, and the two texts a tool call carries are one file
 * each, not a repository.
 */

/** How many unchanged lines stay on each side of a change. */
export const CONTEXT_LINES = 3;
/**
 * The largest LCS table this builds, in cells. Past it the two texts share too
 * little to be worth aligning line by line, and the whole old block is shown
 * removed and the whole new one added instead of freezing the tab. A million
 * cells is a 4 MB table, about 7 ms on a fast machine and several times that
 * on an old phone, all on the main thread.
 */
const CELL_BUDGET = 1_000_000;

export type DiffRow =
  | { kind: 'context'; text: string; oldLine: number; newLine: number }
  | { kind: 'add'; text: string; newLine: number }
  | { kind: 'remove'; text: string; oldLine: number }
  /** The unchanged lines between two hunks, folded to one row. */
  | { kind: 'gap'; hidden: number };

type Op = { kind: 'same' | 'add' | 'remove'; text: string };

/** A trailing newline ends the last line; it is not an empty line of its own. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function at(lines: string[], index: number): string {
  return lines[index] ?? '';
}

function op(kind: Op['kind'], text: string): Op {
  return { kind, text };
}

/** The middle of the two texts, once the shared head and tail are off. */
function middleOps(a: string[], b: string[]): Op[] {
  if (a.length === 0) return b.map((text) => op('add', text));
  if (b.length === 0) return a.map((text) => op('remove', text));
  if (a.length * b.length > CELL_BUDGET) {
    return [...a.map((text) => op('remove', text)), ...b.map((text) => op('add', text))];
  }

  const cols = b.length + 1;
  const table = new Int32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        at(a, i) === at(b, j)
          ? (table[(i + 1) * cols + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * cols + j] ?? 0, table[i * cols + j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (at(a, i) === at(b, j)) {
      ops.push(op('same', at(a, i)));
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * cols + j] ?? 0) >= (table[i * cols + j + 1] ?? 0)) {
      // A removal before an addition, so a changed line reads as `-` then `+`.
      ops.push(op('remove', at(a, i)));
      i += 1;
    } else {
      ops.push(op('add', at(b, j)));
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push(op('remove', at(a, i)));
    i += 1;
  }
  while (j < b.length) {
    ops.push(op('add', at(b, j)));
    j += 1;
  }
  return ops;
}

function opsOf(a: string[], b: string[]): Op[] {
  let head = 0;
  while (head < a.length && head < b.length && at(a, head) === at(b, head)) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    at(a, a.length - 1 - tail) === at(b, b.length - 1 - tail)
  ) {
    tail += 1;
  }
  return [
    ...a.slice(0, head).map((text) => op('same', text)),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map((text) => op('same', text)),
  ];
}

/**
 * The rows a diff view draws: every changed line, `CONTEXT_LINES` of unchanged
 * ones around each change, and one `gap` row for every run of unchanged lines
 * that was folded away. Two identical texts give no row at all.
 */
export function diffRows(oldText: string, newText: string): DiffRow[] {
  const ops = opsOf(splitLines(oldText), splitLines(newText));
  if (!ops.some((entry) => entry.kind !== 'same')) return [];

  const keep = ops.map(() => false);
  ops.forEach((entry, index) => {
    if (entry.kind === 'same') return;
    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);
    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let hidden = 0;
  ops.forEach((entry, index) => {
    if (entry.kind !== 'add') oldLine += 1;
    if (entry.kind !== 'remove') newLine += 1;
    if (keep[index] !== true) {
      hidden += 1;
      return;
    }
    if (hidden > 0) {
      rows.push({ kind: 'gap', hidden });
      hidden = 0;
    }
    if (entry.kind === 'same') rows.push({ kind: 'context', text: entry.text, oldLine, newLine });
    else if (entry.kind === 'add') rows.push({ kind: 'add', text: entry.text, newLine });
    else rows.push({ kind: 'remove', text: entry.text, oldLine });
  });
  if (hidden > 0) rows.push({ kind: 'gap', hidden });
  return rows;
}

/** How many lines the diff adds and how many it removes, for the header. */
export function diffCounts(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added += 1;
    else if (row.kind === 'remove') removed += 1;
  }
  return { added, removed };
}
