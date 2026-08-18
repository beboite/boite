/**
 * Which delegation rows the sidebar actually draws.
 *
 * Children stay on their parent as a pile until that parent is opened. Opening
 * one level reveals only the direct children; a child that asked for its own
 * workers is itself a pile, and those stay folded until that row is opened.
 */

export interface StackableThread {
  id: string;
  parentThreadId?: string | null;
}

export interface DelegationRow<T extends StackableThread> {
  thread: T;
  depth: number;
  /** Direct children still folded into this row. Empty when the row is open. */
  stack: T[];
  /** Every descendant under this row, folded or not, for the count on the pile. */
  foldedCount: number;
  expandable: boolean;
}

export function visibleDelegationRows<T extends StackableThread>(
  threads: readonly T[],
  expanded: Readonly<Record<string, boolean>>,
): DelegationRow<T>[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const children = new Map<string, T[]>();
  for (const t of threads) {
    const parent = t.parentThreadId;
    if (!parent || !byId.has(parent)) continue;
    const list = children.get(parent);
    if (list) list.push(t);
    else children.set(parent, [t]);
  }

  const descendantCount = (id: string, seen: Set<string>): number => {
    let n = 0;
    for (const child of children.get(id) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      n += 1 + descendantCount(child.id, seen);
    }
    return n;
  };

  const rows: DelegationRow<T>[] = [];
  const walked = new Set<string>();
  const bury = (id: string) => {
    for (const child of children.get(id) ?? []) {
      if (walked.has(child.id)) continue;
      walked.add(child.id);
      bury(child.id);
    }
  };
  const walk = (thread: T, depth: number) => {
    if (walked.has(thread.id)) return;
    walked.add(thread.id);
    const kids = children.get(thread.id) ?? [];
    const open = !!expanded[thread.id] && kids.length > 0;
    rows.push({
      thread,
      depth,
      stack: open ? [] : kids,
      foldedCount: descendantCount(thread.id, new Set()),
      expandable: kids.length > 0,
    });
    if (open) {
      for (const child of kids) walk(child, depth + 1);
    } else {
      bury(thread.id);
    }
  };

  for (const t of threads) {
    if (!t.parentThreadId || !byId.has(t.parentThreadId)) walk(t, 0);
  }
  // A parent cycle has no root. Draw whoever was left so the threads still
  // have a row, and `walk` already refuses to enter an id twice.
  for (const t of threads) {
    if (!walked.has(t.id)) walk(t, 0);
  }
  return rows;
}
