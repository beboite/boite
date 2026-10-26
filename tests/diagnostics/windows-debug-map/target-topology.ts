import {existsSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

export interface ProcessIdentity {pid: number; created: string}
export interface TopologyRequest {
  version: 1; phase: 'creator' | 'root' | 'closed'; nonce: string; waiting: boolean;
  helper: ProcessIdentity; creator: ProcessIdentity; root: ProcessIdentity | null;
}
export interface Membership extends ProcessIdentity {
  owner: string; role: string; threadId: string; threadJob: string; globalJob: string;
  nestingRefused: boolean; jobKey?: number; threadMember: number | null; globalMember: number | null;
}
function identity(value: unknown): value is ProcessIdentity {
  const p = value as ProcessIdentity | null;
  return !!p && Number.isSafeInteger(p.pid) && p.pid > 0 && p.pid <= 0xffffffff &&
    typeof p.created === 'string' && /^[1-9]\d{0,19}$/.test(p.created);
}
export function parseTopology(text: string, helperPid: number, phase: TopologyRequest['phase']): TopologyRequest {
  const r = JSON.parse(text) as TopologyRequest;
  if (r.version !== 1 || r.phase !== phase || typeof r.waiting !== 'boolean' || typeof r.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(r.nonce) ||
      !identity(r.helper) || r.helper.pid !== helperPid || !identity(r.creator) ||
      (phase !== 'creator' ? !identity(r.root) : r.root !== null) ||
      new Set([r.helper.pid, r.creator.pid, ...(r.root ? [r.root.pid] : [])]).size !== (r.root ? 3 : 2))
    throw new Error('invalid target creator topology request');
  return r;
}
/** Two independent owners, exact live incarnations, equal owned job references.
 * No process handle values cross this boundary. Missing evidence grants nothing. */
export function proveTopology(request: TopologyRequest, rows: Membership[]): Membership[] | null {
  const processes = [request.helper, request.creator, ...(request.root ? [request.root] : [])];
  const accepted: Membership[] = [];
  for (const role of ['launcher-main', 'harness-main']) {
    const first = rows.filter(r => r.role === role && r.pid === request.helper.pid && r.created === request.helper.created);
    let group: Membership[] | undefined;
    for (const anchor of first) {
      const found = processes.map(p => rows.find(r => r.role === role && r.owner === anchor.owner &&
        r.pid === p.pid && r.created === p.created && r.threadId === anchor.threadId &&
        r.threadJob === anchor.threadJob && r.globalJob === anchor.globalJob && r.nestingRefused === anchor.nestingRefused &&
        /^[1-9]\d*$/.test(r.threadJob) && /^(0|[1-9]\d*)$/.test(r.globalJob) && r.threadMember === 1 &&
        (r.globalJob === '0' ? r.globalMember === null :
          r.globalMember === anchor.globalMember && (r.nestingRefused ? [0, 1].includes(r.globalMember!) : r.globalMember === 1))));
      if (found.every((r): r is Membership => !!r)) {group = found; break;}
    }
    if (!group) return null;
    accepted.push(...group);
  }
  return accepted;
}
export interface LedgerRow {event: string; owner: string; role: string; pid?: number; incarnation?: string; id?: string; success?: boolean; transfer?: {id: string}}
export function traceRows(directory: string): (LedgerRow & Partial<Membership>)[] {
  return readdirSync(directory).filter(f => /^(launcher|harness)-.*\.jsonl$/.test(f)).flatMap(file => {
    const data = readFileSync(join(directory, file), 'utf8');
    // An append in progress can leave the last line incomplete. Never discard
    // malformed complete records or treat the incomplete line as evidence.
    return data.slice(0, data.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
  });
}
/** Every known process reference from both registries, including transfers,
 * must have its original successful closure before the closed gate releases. */
export function creatorReferencesClosed(process: ProcessIdentity, rows: LedgerRow[]): boolean {
  if (rows.some(r => r.event === 'incomplete')) return false;
  const acquired = rows.filter(r => ['acquired', 'transfer-received'].includes(r.event) &&
    r.pid === process.pid && r.incarnation === process.created);
  if (!['launcher-main', 'harness-main'].every(role => acquired.some(r => r.role === role))) return false;
  const ids = new Set(acquired.map(r => r.id));
  if (ids.has(undefined)) return false;
  return [...ids].every(id => rows.some(r => r.event === 'close-result' && r.id === id && r.success === true) &&
    !rows.some(r => r.event === 'close-result' && r.id === id && r.success !== true) &&
    (!rows.some(r => r.event === 'transfer-send' && r.transfer?.id === id) ||
      rows.some(r => r.event === 'transfer-received' && r.id === id)));
}
export async function serveTopology(prefix: string, helperPid: number, trace: string,
    current: (pid: number) => Omit<Membership, 'owner' | 'role'> | null,
    stopped: () => boolean, proofs: unknown[], deferClosure = false,
    beforeRootRelease?: (request: TopologyRequest, proof: Membership[]) => void): Promise<void> {
  let previous: TopologyRequest | undefined;
  let previousProof: Membership[] = [];
  for (const phase of (deferClosure ? ['creator', 'root'] : ['creator', 'root', 'closed']) as TopologyRequest['phase'][]) {
    // Waiting mode executes the existing target/cleanup/final gates before
    // requesting closure. The creator's independent 30s deadline still rules.
    const deadline = Date.now() + (phase === 'closed' ? 35000 : 7000);
    let released = false;
    while (!stopped() && Date.now() < deadline) {
      const path = `${prefix}.${phase}.request`;
      if (existsSync(path)) {
        let text: string;
        try {text = readFileSync(path, 'utf8');}
        catch (error) {
          // C holds share=0 until its complete frame is closed. Retry that
          // sharing conflict only, within the same deadline.
          if (['EBUSY', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            await new Promise(resolve => setTimeout(resolve, 10)); continue;
          }
          throw error;
        }
        const request = parseTopology(text, helperPid, phase);
        if (previous && (request.nonce !== previous.nonce || JSON.stringify(request.helper) !== JSON.stringify(previous.helper) ||
            JSON.stringify(request.creator) !== JSON.stringify(previous.creator) || request.waiting !== previous.waiting ||
            (phase === 'closed' && JSON.stringify(request.root) !== JSON.stringify(previous.root)))) throw new Error('topology phase identity changed');
        const live = [request.helper, request.creator, ...(request.root ? [request.root] : [])].map(p => current(p.pid));
        const rows: Membership[] = live.filter((r): r is NonNullable<typeof r> => !!r)
          .map(r => ({...r, owner: (r as Membership).owner ?? 'current-harness', role: 'harness-main'}));
        const records = traceRows(trace);
        const proof = records.some(r => r.event === 'incomplete') ? null : phase === 'closed'
          ? creatorReferencesClosed(request.creator, records) && live[1] === null && live[0]?.created === request.helper.created &&
            previousProof.filter(r => r.role === 'harness-main' && r.pid === request.helper.pid).some(r =>
              r.threadJob === live[0]!.threadJob && r.globalJob === live[0]!.globalJob &&
              r.nestingRefused === live[0]!.nestingRefused && r.threadMember === live[0]!.threadMember && r.globalMember === live[0]!.globalMember)
            ? previousProof : null
          : proveTopology(request, [...records.filter(r => r.event === 'owned-membership' && r.role === 'launcher-main') as Membership[], ...rows]);
        if (proof) {
          if (phase === 'root') beforeRootRelease?.(request, proof);
          proofs.push({request, proof, ...(phase === 'closed' ? {creatorReferencesClosed: true,
            acquisitions: records.filter(r => ['acquired', 'transfer-received'].includes(r.event) &&
              r.pid === request.creator.pid && r.incarnation === request.creator.created)} : {})});
          writeFileSync(`${prefix}.${phase}.release`, text, {flag: 'wx'});
          previous = request; previousProof = proof; released = true; break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    // Some deliberate faults stop before root creation. No missing evidence
    // becomes permission: C still times out and the native fault must reject.
    if (!released) return;
  }
}
