import type {HandleIdentity, OwnedHandle} from './ownership-ledger.ts';
import type {LedgerRow, Membership, ProcessIdentity, TopologyRequest} from './target-topology.ts';

export interface ReferenceAnchor {
  nonce: string; helper: ProcessIdentity; owner: string; id: string; handle: number;
  threadId: string; threadJob: string; jobKey: number; globalJob: string; nestingRefused: boolean; deadline: number;
}
export interface ReferenceSample extends ReferenceAnchor {transferredAt: number; sampledAt: number; identity: HandleIdentity}
export interface ReferenceClose {id: string; success: boolean; error: number; reason: string; wallMs: number}
export interface HelperReferenceControl {
  arm(request: TopologyRequest, proof: Membership[]): void;
  bound(deadline: number): void;
  pending(): boolean;
  sample(): ReferenceSample;
  close(): ReferenceClose;
  cleanup(): ReferenceClose | undefined;
}
export interface ReferenceDependencies {
  role: string; owner: string;
  reference(handle: number): {entry: OwnedHandle; identity: HandleIdentity; complete: boolean} | undefined;
  close(handle: number, id: string): Omit<ReferenceClose, 'reason'> | undefined;
  event(fields: Record<string, unknown>): void;
}
const fail = (message: string): never => {throw new Error(`helper reference: ${message}`);};

/** One existing handle changes custody within its original owner. No opens,
 * duplicates, waits, rights changes or hidden close retries exist here. */
export class HelperReferenceSlot {
  private anchor?: ReferenceAnchor;
  private held = false;
  private transferredAt = 0;
  private invalid?: string;
  private undecidable = false;
  private result?: ReferenceClose;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private deps: ReferenceDependencies) {}
  private invalidate(message: string): never {this.invalid ??= message; return fail(message);}
  private read(anchor: ReferenceAnchor, exit: number) {
    const r = this.deps.reference(anchor.handle);
    if (!r || !r.complete || r.entry.closeFailed || r.entry.id !== anchor.id || r.entry.from === '' ||
        r.entry.pid !== anchor.helper.pid || r.entry.incarnation !== anchor.helper.created ||
        r.identity.pid !== anchor.helper.pid || r.identity.incarnation !== anchor.helper.created || r.identity.exitCode !== exit)
      {this.undecidable = true; return this.invalidate('owned reference/identity/exit changed');}
    return r;
  }
  arm(anchor: ReferenceAnchor, live: Membership): void {
    if (this.anchor) return this.invalidate('duplicate arm');
    if (this.deps.role !== 'harness-main' || anchor.owner !== this.deps.owner || live.role !== 'harness-main' ||
        live.owner !== anchor.owner || live.pid !== anchor.helper.pid || live.created !== anchor.helper.created ||
        live.threadId !== anchor.threadId || live.threadJob !== anchor.threadJob || live.jobKey !== anchor.jobKey ||
        live.globalJob !== anchor.globalJob || live.nestingRefused !== anchor.nestingRefused || live.threadMember !== 1 ||
        (live.globalJob === '0' ? live.globalMember !== null : live.nestingRefused ? ![0, 1].includes(live.globalMember!) : live.globalMember !== 1) ||
        !/^[a-f0-9]{32}$/.test(anchor.nonce) || !anchor.id || !Number.isSafeInteger(anchor.handle) || anchor.handle <= 0 ||
        !Number.isSafeInteger(anchor.jobKey) || anchor.jobKey <= 0 || !Number.isSafeInteger(anchor.deadline) ||
        anchor.deadline <= Date.now() || anchor.deadline > Date.now() + 30000)
      return this.invalidate('arm ownership/topology/deadline');
    this.read(anchor, 259);
    this.anchor = structuredClone(anchor); this.schedule();
    this.deps.event({event: 'helper-reference-armed', ...this.anchor});
  }
  /** Called only at the original reportExit close site, after tracked.delete.
   * Returning true makes the slot responsible for the one original closure. */
  retain(handle: number, pid: number, created: string | undefined, threadId: string, code: number | null,
      job?: Pick<ReferenceAnchor, 'threadJob' | 'jobKey' | 'globalJob' | 'nestingRefused'>): boolean {
    const a = this.anchor;
    if (!a || a.handle !== handle) return false;
    if (this.held) {this.invalid ??= 'duplicate transfer'; return true;}
    if (this.result) return false;
    try {
      if (this.invalid || pid !== a.helper.pid || created !== a.helper.created || threadId !== a.threadId || code !== 125 ||
          !job || job.threadJob !== a.threadJob || job.jobKey !== a.jobKey || job.globalJob !== a.globalJob ||
          job.nestingRefused !== a.nestingRefused || Date.now() >= a.deadline)
        this.invalidate('transfer identity/deadline/exit');
      this.read(a, 125); this.held = true; this.transferredAt = Date.now();
      this.deps.event({event: 'helper-reference-held', ...a, transferredAt: this.transferredAt}); return true;
    } catch (error) {
      this.invalid ??= String(error); return false; // The original owner still closes an untransferred handle.
    }
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {this.invalid ??= 'deadline'; this.finish('deadline');}, Math.max(0, this.anchor!.deadline - Date.now()));
    this.timer.unref();
  }
  bound(deadline: number): void {
    if (!this.anchor || this.invalid || this.result || Date.now() >= this.anchor.deadline)
      return this.invalidate(this.invalid ?? 'not armed/deadline');
    if (!Number.isSafeInteger(deadline) || deadline <= Date.now() || deadline > this.anchor!.deadline || deadline > Date.now() + 3000)
      return this.invalidate('observation deadline');
    this.anchor!.deadline = deadline; this.schedule();
  }
  pending(): boolean {
    if (!this.anchor || this.invalid || this.result || Date.now() >= this.anchor.deadline)
      return this.invalidate(this.invalid ?? 'not armed/deadline');
    return !this.held;
  }
  sample(): ReferenceSample {
    if (this.invalid || !this.anchor || !this.held || this.result || Date.now() >= this.anchor.deadline)
      return this.invalidate(this.invalid ?? 'not held/early close/deadline');
    const r = this.read(this.anchor, 125);
    return {...structuredClone(this.anchor), transferredAt: this.transferredAt, sampledAt: Date.now(), identity: r.identity};
  }
  private finish(reason: string): ReferenceClose | undefined {
    if (this.timer) clearTimeout(this.timer); this.timer = undefined;
    if (this.result || !this.held || !this.anchor) return this.result;
    const a = this.anchor;
    // Check custody without querying a potentially already-closed value. The
    // dependency returns no entry, and never reads native state, after closure.
    let owned: ReturnType<ReferenceDependencies['reference']>;
    try {if (!this.undecidable) owned = this.deps.reference(a.handle);}
    catch (error) {this.invalid ??= String(error);}
    this.held = false;
    if (!owned || !owned.complete || owned.entry.id !== a.id || owned.entry.closeFailed || owned.identity.pid !== a.helper.pid ||
        owned.identity.incarnation !== a.helper.created || owned.identity.exitCode !== 125) {
      this.invalid ??= 'custody lost before close';
      this.result = {id: a.id, success: false, error: 6, reason, wallMs: Date.now()};
    } else {
      // Set the attempted state first: a thrown/failed native close is never retried.
      this.result = {id: a.id, success: false, error: 6, reason, wallMs: Date.now()};
      try {
        const closed = this.deps.close(a.handle, a.id);
        if (closed?.id === a.id && closed.wallMs >= this.transferredAt) this.result = {...closed, reason};
      }
      catch (error) {this.invalid ??= String(error);}
    }
    if (!this.result.success) this.invalid ??= 'actual closure failed';
    this.deps.event({event: 'helper-reference-closed', nonce: a.nonce, ...this.result});
    return this.result;
  }
  close(): ReferenceClose {
    this.sample();
    const result = this.finish('observed')!;
    if (!result.success || this.invalid || Date.now() >= this.anchor!.deadline) return fail(this.invalid ?? 'actual closure failed/deadline');
    return result;
  }
  cleanup(): ReferenceClose | undefined {
    if (!this.result) this.invalid ??= 'cleanup before accepted closure';
    return this.finish('cleanup');
  }
}

/** Every other exact-incarnation acquisition and worker transfer must drain.
 * The retained ID must still have exactly one unclosed harness-main custody. */
export function otherReferencesClosed(process: ProcessIdentity, sample: ReferenceSample, rows: LedgerRow[]): boolean {
  if (rows.some(r => r.event === 'incomplete') || sample.helper.pid !== process.pid || sample.helper.created !== process.created) return false;
  const acquired = rows.filter(r => ['acquired', 'transfer-received'].includes(r.event) && r.pid === process.pid && r.incarnation === process.created);
  if (!['launcher-main', 'harness-main'].every(role => acquired.some(r => r.role === role)) ||
      !acquired.some(r => r.id === sample.id && r.owner === sample.owner && r.role === 'harness-main') ||
      rows.some(r => r.event === 'close-result' && r.id === sample.id)) return false;
  const ids = new Set(acquired.map(r => r.id)); if (ids.has(undefined)) return false;
  return [...ids].every(id => (id === sample.id || rows.some(r => r.event === 'close-result' && r.id === id && r.success === true)) &&
    !rows.some(r => r.event === 'close-result' && r.id === id && r.success !== true) &&
    (!rows.some(r => r.event === 'transfer-send' && r.transfer?.id === id) || rows.some(r => r.event === 'transfer-received' && r.id === id)));
}
