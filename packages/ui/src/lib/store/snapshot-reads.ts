/** Changes are retained only while a list response is waiting to be applied. */
export class SnapshotReads<T extends { id: string }> {
  #sequence = 0;
  #reads = new Set<SnapshotRead<T>>();
  constructor(private readonly group: (row: T) => string) {}

  begin(scope = 'all'): SnapshotRead<T> {
    const sequence = ++this.#sequence;
    for (const older of this.#reads) {
      if (scope === 'all' || older.scope === 'all' || older.scope === scope) older.protect(scope, sequence);
    }
    const read = new SnapshotRead(scope, sequence, this.group, (applied) => {
      this.#reads.delete(read);
      for (const older of this.#reads) older.release(scope, sequence, applied);
    });
    this.#reads.add(read);
    return read;
  }

  change(id: string, row: T | null): void {
    for (const read of this.#reads) read.changes.set(id, row);
  }

  clear(): void { for (const read of this.#reads) read.cancel(); }
}

export class SnapshotRead<T extends { id: string }> {
  readonly changes = new Map<string, T | null>();
  readonly protected = new Map<string, { pending: Set<number>; applied: boolean }>();
  active = true;
  constructor(readonly scope: string, readonly sequence: number, private readonly group: (row: T) => string, private readonly close: (applied: boolean) => void) {}

  protect(scope: string, sequence: number): void {
    const entry = this.protected.get(scope) ?? { pending: new Set<number>(), applied: false };
    entry.pending.add(sequence); this.protected.set(scope, entry);
  }

  release(scope: string, sequence: number, applied: boolean): void {
    const entry = this.protected.get(scope);
    if (!entry?.pending.delete(sequence)) return;
    entry.applied ||= applied;
    if (!entry.applied && entry.pending.size === 0) this.protected.delete(scope);
  }

  /** Fresh unrelated rows still land; newer reads and events own their rows. */
  apply(fresh: readonly T[], held: readonly T[]): T[] {
    if (!this.active) return [...held];
    const owned = (row: T) => this.scope === 'all' || this.group(row) === this.scope;
    const protectedRow = (row: T) => this.protected.has('all') || this.protected.has(this.group(row));
    const rows = new Map(held.filter(row => !owned(row) || protectedRow(row)).map(row => [row.id, row]));
    for (const row of fresh) if (owned(row) && !protectedRow(row) && !this.changes.has(row.id)) rows.set(row.id, row);
    for (const [id, changed] of this.changes) {
      const row = changed ?? rows.get(id) ?? fresh.find(row => row.id === id);
      if (row && (!owned(row) || protectedRow(row))) continue;
      if (changed) rows.set(id, changed); else rows.delete(id);
    }
    this.#finish(true);
    return [...rows.values()];
  }

  cancel(): void { this.#finish(false); }
  #finish(applied: boolean): void {
    if (!this.active) return;
    this.active = false;
    this.close(applied);
    this.changes.clear();
    this.protected.clear();
  }
}

/** Preserve held row identity while applying a current authoritative list. */
export function retainRows<T extends { id: string }>(held: readonly T[], fresh: T[]): T[] {
  const rows = new Map(held.map(row => [row.id, row]));
  return fresh.map(next => {
    const row = rows.get(next.id);
    if (!row || row === next) return next;
    const target = row as Record<string, unknown>, source = next as Record<string, unknown>;
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
    for (const [key, value] of Object.entries(source)) if (!Object.is(target[key], value)) target[key] = value;
    return row;
  });
}
