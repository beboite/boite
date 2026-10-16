/**
 * The line diff a `diff` tool document is drawn from. No dependency: the whole
 * job is Myers' O(ND) shortest edit script over lines, and the two texts a
 * tool call carries are one file each, not a repository.
 */

/** How many unchanged lines stay on each side of a change. */
export const CONTEXT_LINES = 3;
/**
 * The most lines the two middles may differ by and still be aligned. The
 * search takes about D^2/2 steps and keeps as many integers for the walk back,
 * so 2,000 is at most 2 million steps and 8 MB, half the 2,000 by 2,000 LCS
 * table this replaced. Its cost follows the size of the change, not the size
 * of the file: two edits 1,000 lines apart are a D of 4. Past the limit the
 * texts share too little to be worth aligning, and the whole old block is
 * shown removed and the whole new one added.
 */
export const MAX_EDITS = 2_000;

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

/**
 * The furthest x each diagonal k = x - y reaches with d edits, for every d so
 * far, row after row in one buffer: row d holds k = -d, -d + 2 .. d. Keeping
 * every row is what lets the walk back rebuild the path.
 */
class Rounds {
  cells = new Int32Array(1024);

  /** Where row d starts in `cells`. */
  static start(d: number): number {
    return (d * (d + 1)) / 2;
  }

  /** Makes room for row d before the search writes it. */
  reserve(d: number): void {
    const needed = Rounds.start(d + 1);
    if (needed <= this.cells.length) return;
    const grown = new Int32Array(Math.max(needed, this.cells.length * 2));
    grown.set(this.cells);
    this.cells = grown;
  }

  /** Row -1 is the empty start, as if one step above the top left corner. */
  get(d: number, k: number): number {
    if (d < 0) return 0;
    return this.cells[Rounds.start(d) + (k + d) / 2] ?? 0;
  }

  /**
   * Whether round d reaches diagonal k from k + 1, an addition, rather than
   * from k - 1, a removal. Ties take the removal, so a changed line reads as
   * `-` then `+`.
   */
  comesDown(d: number, k: number): boolean {
    return k === -d || (k !== d && this.get(d - 1, k - 1) < this.get(d - 1, k + 1));
  }
}

/**
 * The middle of the two texts, once the shared head and tail are off: Myers'
 * greedy search forward, then a walk back through the rows it kept.
 */
function middleOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => op('add', text));
  if (m === 0) return a.map((text) => op('remove', text));
  const unaligned = (): Op[] => [
    ...a.map((text) => op('remove', text)),
    ...b.map((text) => op('add', text)),
  ];
  // A line can only be kept as often as both sides have it, so the edits are
  // at least n + m less twice that: two unrelated blocks stop here at once.
  const counts = new Map<string, number>();
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1);
  let keepable = 0;
  for (const line of b) {
    const left = counts.get(line) ?? 0;
    if (left === 0) continue;
    counts.set(line, left - 1);
    keepable += 1;
  }
  if (n + m - 2 * keepable > MAX_EDITS) return unaligned();

  const rounds = new Rounds();
  const limit = Math.min(n + m, MAX_EDITS);
  let edits = -1;
  search: for (let d = 0; d <= limit; d += 1) {
    rounds.reserve(d);
    const cells = rounds.cells;
    const row = Rounds.start(d);
    const previous = d > 0 ? Rounds.start(d - 1) : 0;
    // The hot loop, with comesDown and get written out: diagonal k is entry i
    // of row d, and in row d - 1, k - 1 is entry i - 1 and k + 1 is entry i.
    for (let k = -d, i = 0; k <= d; k += 2, i += 1) {
      // Round 0 starts at x = 0; off either edge of row d - 1 there is no entry.
      const fromAbove = d === 0 ? 0 : k === d ? -1 : (cells[previous + i] ?? 0);
      const fromLeft = k === -d ? -1 : (cells[previous + i - 1] ?? 0);
      let x = k === -d || (k !== d && fromLeft < fromAbove) ? fromAbove : fromLeft + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      cells[row + i] = x;
      if (x >= n && y >= m) {
        edits = d;
        break search;
      }
    }
  }
  if (edits < 0) return unaligned();

  const reversed: Op[] = [];
  let x = n;
  let y = m;
  for (let d = edits; d >= 0; d -= 1) {
    const k = x - y;
    const down = rounds.comesDown(d, k);
    const fromK = down ? k + 1 : k - 1;
    // Round 0 starts from the empty row, as if one step above the top left.
    const fromX = rounds.get(d - 1, fromK);
    const fromY = fromX - fromK;
    // The run of equal lines this round ended on starts right after its edit.
    const runStart = down ? fromX : fromX + 1;
    while (x > runStart) {
      x -= 1;
      y -= 1;
      reversed.push(op('same', at(a, x)));
    }
    if (d === 0) break;
    if (down) reversed.push(op('add', at(b, fromY)));
    else reversed.push(op('remove', at(a, fromX)));
    x = fromX;
    y = fromY;
  }
  return reversed.reverse();
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

/** What a line is compared by when whitespace is ignored: its text with every space and tab gone. */
function squeezed(line: string): string {
  return line.replace(/\s+/g, '');
}

/**
 * The edit script over whitespace-free lines, carried back to the real ones.
 * A line that only moved its spaces is kept, shown the way the new text has it.
 */
function opsIgnoringWhitespace(a: string[], b: string[]): Op[] {
  let i = 0;
  let j = 0;
  return opsOf(a.map(squeezed), b.map(squeezed)).map((entry) => {
    if (entry.kind === 'remove') return op('remove', at(a, i++));
    if (entry.kind === 'add') return op('add', at(b, j++));
    i += 1;
    return op('same', at(b, j++));
  });
}

export interface DiffOptions {
  /** Lines that differ only in spaces and tabs count as unchanged. */
  ignoreWhitespace?: boolean;
}

/**
 * The rows a diff view draws: every changed line, `CONTEXT_LINES` of unchanged
 * ones around each change, and one `gap` row for every run of unchanged lines
 * that was folded away. Two identical texts give no row at all.
 */
export function diffRows(oldText: string, newText: string, options: DiffOptions = {}): DiffRow[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = options.ignoreWhitespace === true ? opsIgnoringWhitespace(a, b) : opsOf(a, b);
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

/** One line of the side-by-side view: the old side on the left, the new on the right, either empty. */
export type SplitRow =
  | { kind: 'pair'; left: Exclude<DiffRow, { kind: 'gap' }> | null; right: Exclude<DiffRow, { kind: 'gap' }> | null }
  | { kind: 'gap'; hidden: number };

/**
 * The unified rows set side by side: a context line on both sides, and each run
 * of removals faced with the additions that follow it, line for line, so a
 * changed line reads across. The longer side of a run leaves the other empty.
 */
export function splitRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (row.kind === 'gap') { out.push(row); index += 1; continue; }
    if (row.kind === 'context') { out.push({ kind: 'pair', left: row, right: row }); index += 1; continue; }
    const removed: Extract<DiffRow, { kind: 'remove' }>[] = [];
    const added: Extract<DiffRow, { kind: 'add' }>[] = [];
    while (rows[index]?.kind === 'remove') removed.push(rows[index++] as Extract<DiffRow, { kind: 'remove' }>);
    while (rows[index]?.kind === 'add') added.push(rows[index++] as Extract<DiffRow, { kind: 'add' }>);
    for (let k = 0; k < Math.max(removed.length, added.length); k += 1) {
      out.push({ kind: 'pair', left: removed[k] ?? null, right: added[k] ?? null });
    }
  }
  return out;
}
