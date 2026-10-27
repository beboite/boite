import {existsSync, lstatSync, readFileSync, writeFileSync} from 'node:fs';
import {creatorReferencesClosed, traceRows, type TopologyRequest, type Membership} from './target-topology.ts';
import type {Captured} from './capture.ts';
import {otherReferencesClosed, type HelperReferenceControl} from './helper-reference.ts';

export interface JobAccounting {
  owner: string; threadId: string; threadJob: string; jobKey: number; globalJob: string;
  nestingRefused: boolean; active: number; wallMs: number;
}
export interface HoldFrame {
  version: 1; phase: 'hold'; nonce: string; helper: TopologyRequest['helper'];
  creator: TopologyRequest['creator']; root: NonNullable<TopologyRequest['root']>;
  deadlineWallMs: number; closed: number; ioAcquired: number; ioClosed: number;
}
export interface RootProof {request: TopologyRequest; proof: Membership[]}
type Row = ReturnType<typeof traceRows>[number] & {key?: number; message?: number; created?: string; exitCode?: number};
function readControl(path: string): string | null {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('invalid helper-job rendezvous file');
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function parseHold(text: string, expected: TopologyRequest, now: number): HoldFrame {
  const f = JSON.parse(text) as HoldFrame;
  if (expected.phase !== 'root' || !expected.root || f.version !== 1 || f.phase !== 'hold' || f.nonce !== expected.nonce || !expected.waiting ||
      !equal(f.helper, expected.helper) || !equal(f.creator, expected.creator) || !equal(f.root, expected.root) ||
      !Number.isSafeInteger(f.deadlineWallMs) || f.deadlineWallMs <= now || f.deadlineWallMs > now + 3000 ||
      f.closed !== 7 || !Number.isSafeInteger(f.ioAcquired) || f.ioAcquired < 1 || f.ioAcquired !== f.ioClosed)
    throw new Error('invalid helper-job hold identity/nonce/deadline/closure');
  return f;
}
export function sameJob(a: JobAccounting, b: JobAccounting): boolean {
  return a.owner === b.owner && a.threadId === b.threadId && a.threadJob === b.threadJob && a.jobKey === b.jobKey &&
    a.globalJob === b.globalJob && a.nestingRefused === b.nestingRefused;
}
export function populatedProof(frame: HoldFrame, root: RootProof, live: Membership | null,
    accounting: JobAccounting | null, rows: Row[]): boolean {
  const anchors = root.proof.filter(r => r.role === 'harness-main' && r.pid === frame.helper.pid);
  if (!live || !accounting || !Number.isSafeInteger(accounting.active) || accounting.active < 1 || !anchors.length ||
      live.pid !== frame.creator.pid || live.created !== frame.creator.created || live.threadMember !== 1 ||
      !anchors.some(a => a.owner === live.owner && a.threadId === live.threadId && a.threadJob === live.threadJob && a.jobKey === live.jobKey &&
        a.globalJob === live.globalJob && a.nestingRefused === live.nestingRefused && a.globalMember === live.globalMember) ||
      !sameJob(accounting, {...live, jobKey: live.jobKey!, active: 1, wallMs: accounting.wallMs}) ||
      !Number.isSafeInteger(accounting.jobKey) || accounting.jobKey <= 0) return false;
  for (const role of ['launcher-main', 'harness-main']) {
    const anchor = root.proof.find(r => r.role === role && r.pid === frame.helper.pid);
    if (!anchor || !Number.isSafeInteger(anchor.jobKey) || !rows.some(r => r.event === 'owned-membership' &&
        r.role === role && r.owner === anchor.owner && r.pid === frame.creator.pid && r.created === frame.creator.created &&
        r.threadId === anchor.threadId && r.threadJob === anchor.threadJob && r.jobKey === anchor.jobKey &&
        r.globalJob === anchor.globalJob && r.globalMember === anchor.globalMember && r.threadMember === 1)) return false;
    if (rows.some(r => r.event === 'job-packet' && r.owner === anchor.owner && r.key === anchor.jobKey && r.message === 4)) return false;
  }
  return !rows.some(r => r.event === 'incomplete');
}
export function releasedProof(frame: HoldFrame, anchor: JobAccounting, accounting: JobAccounting | null, rows: Row[]): boolean {
  return !!accounting && sameJob(anchor, accounting) && accounting.active === 0 &&
    creatorReferencesClosed(frame.creator, rows) && ['launcher-main', 'harness-main'].every(role => rows.some(r =>
      r.event === 'owned-exit' && r.role === role && r.pid === frame.creator.pid && r.created === frame.creator.created && r.exitCode === 0));
}
export function observation(path: string, result: Captured): {path: string; absent: boolean; status: string; result: Captured} {
  const line = result.out.replace(/\r?\n$/, '');
  const absent = line === `map-after-helper-exit path=${path} open=0xc0000034 absent=1 closed=1 error=0`;
  const present = line === `map-after-helper-exit path=${path} open=0x00000000 absent=0 closed=1 error=0`;
  if (result.code !== 0 || result.timedOut || !/\r?\n$/.test(result.out) || (!absent && !present))
    throw new Error('invalid helper-job exact-name observation');
  return {path, absent, status: absent ? '0xc0000034' : '0x00000000', result};
}
interface HelperJobOptions {
  prefix: string; helper: Captured; roots: RootProof[]; trace: string;
  live: (pid: number) => Omit<Membership, 'role'> | null;
  job: (threadId: string) => JobAccounting | null;
  observe: (path: string, phase: string, index: number, milliseconds: number) => Promise<Captured>;
  record: Record<string, unknown>;
  reference?: HelperReferenceControl;
}
export async function observeHelperJob(options: HelperJobOptions): Promise<void> {
  try {await observeHelperJobBody(options);}
  finally {
    if (options.reference) {
      const closed = options.reference.cleanup(); options.record.referenceCleanup = closed;
      if (!closed?.success || closed.reason !== 'observed') options.record.protocolValid = false;
    }
  }
}
async function observeHelperJobBody(options: HelperJobOptions): Promise<void> {
  const {prefix, helper, trace, record} = options;
  const started = Date.now(), externalDeadline = started + 5000;
  record.protocolValid = false; record.productionAccepted = false; record.helperExitObservedAt = started;
  record.causeConfirmed = false;
  const root = options.roots.find(p => p.request.phase === 'root' && p.request.helper.pid === helper.pid);
  if (!root || helper.timedOut || helper.code === null) throw new Error('helper-job requires captured helper exit and root proof');
  const text = readControl(`${prefix}.hold.ready`);
  if (text === null) throw new Error('helper-job closed ready file missing');
  const frame = parseHold(text, root.request, Date.now());
  record.frame = frame; record.rootProof = root;
  options.reference?.bound(frame.deadlineWallMs);
  const limit = Math.min(frame.deadlineWallMs, started + 3000, externalDeadline);
  const checkDeadline = () => {if (Date.now() >= limit) throw new Error('helper-job populated observation deadline');};
  const before: unknown[] = [], after: unknown[] = []; record.populated = before; record.empty = after;
  function snapshot() {
    checkDeadline();
    if (existsSync(`${prefix}.hold.release`) || existsSync(`${prefix}.hold.done`)) throw new Error('helper-job early release');
    const member = options.live(frame.creator.pid);
    const live = member ? {...member, role: 'harness-main'} : null;
    const accounting = options.job(member?.threadId ?? root!.proof.find(r => r.role === 'harness-main')!.threadId);
    if (!populatedProof(frame, root!, live, accounting, traceRows(trace) as Row[])) throw new Error('helper-job populated ownership/key/membership/zero evidence');
    return {live, accounting: accounting!};
  }
  const referenceDrained = () => options.reference
    ? otherReferencesClosed(frame.helper, options.reference.sample(), traceRows(trace))
    : creatorReferencesClosed(frame.helper, traceRows(trace));
  while (options.reference?.pending()) {
    checkDeadline(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  while (!referenceDrained()) {
    checkDeadline(); await new Promise(resolve => setTimeout(resolve, 5));
  }
  record.helperRegistryExits = traceRows(trace).filter(r => r.event === 'owned-exit' && r.pid === frame.helper.pid &&
    r.created === frame.helper.created);
  const initial = snapshot(), anchor = initial.accounting; record.anchor = anchor;
  // Names must come from this helper's successful owned creations, not ambient input.
  const original = helper.err.match(/^private-map path=(.+) create=0x00000000\r?$/m)?.[1]?.replace(/\r$/, '');
  const retired = helper.err.match(/^map-retire named path=(.+) create=0x00000000\r?$/m)?.[1]?.replace(/\r$/, '');
  const suffix = original?.replace(/^\\Sessions\\\d+(?=\\BaseNamedObjects\\)/, '');
  if (!original || !retired || suffix !== String.raw`\BaseNamedObjects\boite.route.${helper.pid}` || retired !== `${original}.retired`)
    throw new Error('helper-job owned names missing');
  const names = [original, retired];
  if (options.reference) {
    const held: unknown[] = []; record.held = held;
    for (let pass = 0; pass < 2; pass++) for (const [index, name] of names.entries()) {
      const pre = snapshot(), referencePre = options.reference.sample();
      if (!referenceDrained()) throw new Error('helper reference other registry closure changed');
      const result = observation(name, await options.observe(name, `held-${pass}`, index, Math.min(1000, limit - Date.now())));
      const referencePost = options.reference.sample(), post = snapshot();
      if (!referenceDrained()) throw new Error('helper reference other registry closure changed');
      held.push({pre, referencePre, observation: result, referencePost, post});
    }
    checkDeadline(); record.referenceClose = options.reference.close();
    if (!creatorReferencesClosed(frame.helper, traceRows(trace))) throw new Error('helper reference final closure ledger missing');
  }
  for (const [index, name] of names.entries()) {
    const pre = snapshot();
    const result = observation(name, await options.observe(name, 'populated', index, Math.min(1000, limit - Date.now())));
    const post = snapshot(); before.push({pre, observation: result, post});
  }
  checkDeadline();
  if (existsSync(`${prefix}.hold.release`) || existsSync(`${prefix}.hold.done`)) throw new Error('helper-job early release');
  record.releasedAt = Date.now(); writeFileSync(`${prefix}.hold.release`, text, {flag: 'wx'});
  // Release occurs before the strict 3s hold limit. Registry packet/closure drain
  // has the remainder of the independently bounded 5s external budget.
  let closed = false;
  while (Date.now() < externalDeadline) {
    const accounting = options.job(anchor.threadId), rows = traceRows(trace) as Row[];
    if (readControl(`${prefix}.hold.done`) === text &&
        options.live(frame.creator.pid) === null && releasedProof(frame, anchor, accounting, rows)) {
      record.creatorClosedAt = Date.now();
      // A reused PID does not identify the captured creator's reference ledger.
      const ids = new Set(rows.filter(r => r.pid === frame.creator.pid && r.incarnation === frame.creator.created)
        .flatMap(r => r.id ? [r.id] : []));
      record.closureRows = rows.filter(r => (r.pid === frame.creator.pid && (r.incarnation ?? r.created) === frame.creator.created) ||
        (r.id && ids.has(r.id)) || (r.transfer && ids.has(r.transfer.id)));
      record.emptyAccounting = accounting; closed = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (!closed) throw new Error('helper-job exit0/closure/accounting deadline');
  for (const [index, name] of names.entries()) {
    if (Date.now() >= externalDeadline) throw new Error('helper-job empty observation deadline');
    const pre = options.job(anchor.threadId);
    if (!pre || !sameJob(anchor, pre) || pre.active !== 0) throw new Error('helper-job empty job changed');
    const result = observation(name, await options.observe(name, 'empty', index, Math.min(1000, externalDeadline - Date.now())));
    const post = options.job(anchor.threadId);
    if (Date.now() >= externalDeadline || !post || !sameJob(anchor, post) || post.active !== 0) throw new Error('helper-job empty observation changed');
    after.push({pre, observation: result, post});
  }
  record.protocolValid = true;
}
