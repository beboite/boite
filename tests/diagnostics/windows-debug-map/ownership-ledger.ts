export interface HandleIdentity {pid: number | null; incarnation: string | null; exitCode: number | null}
export interface Transfer {id: string; pid: number; incarnation: string | null; from: string}
export interface OwnedHandle extends Transfer {handle: number; stage: string; closeFailed?: boolean}
export type TraceEvent = Record<string, unknown> & {event: string};

/** Only explicitly acquired/transferred process handles enter this ledger. */
export class OwnershipLedger {
  readonly owned = new Map<number, OwnedHandle>();
  readonly outgoing = new Map<string, Transfer>();
  complete = true;
  private generation = 0;
  constructor(readonly owner: string, private emit: (event: TraceEvent) => void) {}

  incomplete(reason: string, fields: Record<string, unknown> = {}): void {
    this.complete = false; this.emit({event: 'incomplete', reason, ...fields});
  }
  acquire(handle: number, pid: number, identity: HandleIdentity, transfer?: Transfer): void {
    if (!Number.isSafeInteger(handle) || handle <= 0) {
      this.emit({event: 'open-failed', pid, handle}); return;
    }
    const previous = this.owned.get(handle);
    if (previous) this.incomplete('handle reused before successful recorded close', {previous, handle});
    const entry: OwnedHandle = {id: transfer?.id ?? `${this.owner}/${++this.generation}`,
      from: transfer?.from ?? this.owner, handle, pid, incarnation: identity.incarnation, stage: 'acquired'};
    this.owned.set(handle, entry);
    if (identity.pid !== pid || !identity.incarnation || identity.exitCode === null || (transfer &&
      (transfer.pid !== pid || transfer.incarnation !== identity.incarnation))) {
      this.incomplete('missing or mismatched captured identity', {entry, identity, transfer});
    }
    this.emit({event: transfer ? 'transfer-received' : 'acquired', ...entry, identity});
  }
  transfer(handle: number): Transfer | undefined {
    const entry = this.owned.get(handle);
    if (!entry) {this.incomplete('transfer without acquisition', {handle}); return;}
    const transfer: Transfer = {id: entry.id, pid: entry.pid, incarnation: entry.incarnation, from: entry.from};
    this.owned.delete(handle); this.outgoing.set(transfer.id, transfer);
    this.emit({event: 'transfer-send', handle, transfer}); return transfer;
  }
  stage(handle: number, stage: string, fields: Record<string, unknown> = {}): void {
    const entry = this.owned.get(handle);
    if (!entry) {this.incomplete('stage without ownership', {handle, stage}); return;}
    entry.stage = stage; this.emit({event: stage, ...entry, ...fields});
  }
  close(handle: number, success: boolean, error: number): void {
    const entry = this.owned.get(handle);
    // Jobs, ports and other original closures are outside the process ledger.
    if (!entry) return;
    if (entry.closeFailed) {
      this.incomplete('subsequent original closure has undecidable generation', {handle, success, error}); return;
    }
    this.emit({event: 'close-result', ...entry, success, error});
    if (success) this.owned.delete(handle);
    else {entry.closeFailed = true; this.incomplete('original CloseHandle failed', {entry, error});}
  }
  snapshot(read: (handle: number) => HandleIdentity): void {
    for (const entry of this.owned.values()) {
      // A failed close leaves ownership undecidable: never query that value again.
      const identity = entry.closeFailed ? null : read(entry.handle);
      if (identity && (identity.pid !== entry.pid || identity.incarnation !== entry.incarnation || identity.exitCode === null))
        this.incomplete('snapshot identity changed or unreadable', {entry, identity});
      this.emit({event: 'snapshot', ...entry, identity});
    }
    this.emit({event: 'ledger', complete: this.complete, owned: this.owned.size,
      outgoing: [...this.outgoing.values()]});
  }
}
