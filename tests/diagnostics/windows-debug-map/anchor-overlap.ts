import type {Captured} from './capture.ts';
import {validateDirectoryTwin, type DirectoryTwinReport} from './directory-twin.ts';
import type {validateRetirementTiming} from './retirement-timing.ts';
import {creatorReferencesClosed, proveTopology, type LedgerRow, type Membership, type TopologyRequest} from './target-topology.ts';

export type AnchorMode = 'exclusive' | 'held';
export interface AnchorEvent {
  phase: string; mode: AnchorMode; nonce: string; helper: number; helperCreated: string; setter: number; setterCreated: string;
  root: number; created: string; tid: number; threadCreated: string; path: string; now: number; started: number; deadline: number;
  status: string; closed: number; verified: number; processAccess: string; mapAccess: string; flags: number; error: number;
}
export interface AnchorReport extends DirectoryTwinReport {
  mode: AnchorMode; anchorEvents: AnchorEvent[]; setter?: {pid: number; created: string}; checkpointAt?: number;
  registryCorroborated: boolean; registryError?: string;
}
const fields = ['phase', 'mode', 'nonce', 'helper', 'helper-created', 'setter', 'setter-created', 'root', 'created', 'tid', 'thread-created',
  'path', 'now', 'started', 'deadline', 'status', 'closed', 'verified', 'process-access', 'map-access', 'flags', 'error'];
function requireValue(value: unknown, error: string): asserts value {if (!value) throw new Error(`anchor overlap: ${error}`);}
function parse(line: string): AnchorEvent {
  const tokens = line.split(' '), values: Record<string, string> = {};
  requireValue(tokens.shift() === 'anchor-overlap' && tokens.length === fields.length, 'record fields');
  for (const [i,token] of tokens.entries()) {
    const split = token.indexOf('='); requireValue(token.slice(0,split) === fields[i], 'field order'); values[fields[i]!] = token.slice(split+1);
  }
  const number = (key: string) => {const n = Number(values[key]); requireValue(/^\d+$/.test(values[key]!) && Number.isSafeInteger(n), key); return n;};
  for (const key of ['helper-created','setter-created','created','thread-created']) requireValue(/^[1-9]\d{0,19}$/.test(values[key]!), key);
  requireValue(values.mode === 'exclusive' || values.mode === 'held', 'mode'); requireValue(/^[a-f0-9]{32}$/.test(values.nonce!), 'nonce');
  return {phase:values.phase!, mode:values.mode, nonce:values.nonce!, helper:number('helper'), helperCreated:values['helper-created']!,
    setter:number('setter'), setterCreated:values['setter-created']!, root:number('root'), created:values.created!, tid:number('tid'), threadCreated:values['thread-created']!,
    path:values.path!, now:number('now'), started:number('started'), deadline:number('deadline'), status:values.status!, closed:number('closed'), verified:number('verified'),
    processAccess:values['process-access']!, mapAccess:values['map-access']!, flags:number('flags'), error:number('error')};
}
export function validateAnchorOverlap(result: Captured, expected: Parameters<typeof validateRetirementTiming>[1], mode: AnchorMode): AnchorReport {
  const twin = validateDirectoryTwin(result, {...expected, anchorMode:mode});
  const report: AnchorReport = {...twin, mode, anchorEvents:[], registryCorroborated:false};
  try {
    requireValue(twin.protocolValid && twin.prerequisites, `LIVE/twin gates: ${twin.error}`);
    const lines = result.err.split(/\r?\n/), events = lines.filter(l=>l.startsWith('anchor-overlap ')).map(parse);
    report.anchorEvents = events;
    const phases = ['duplicate-process','duplicate-directory','start','close-transfer-process','close-transfer-directory','request','child-ready',
      ...(mode === 'exclusive' ? ['helper-close'] : []), 'go','child-set', ...(mode === 'held' ? ['helper-close'] : []), 'release',
      'child-close-directory','child-close-process','child-exit','close-parent-thread','close-parent-process','close-parent-job','registry-closed'];
    requireValue(events.map(e=>e.phase).join() === phases.join(), 'exact native operation order');
    const first=events[0]!, root=twin.timing!.frames[0]!, suspend=twin.timing!.frames.find(f=>f.phase==='suspend')!;
    requireValue(first.setter>0 && first.setter<=0xffffffff && first.setter!==expected.helper.pid && first.setter!==expected.root.pid, 'distinct captured setter');
    report.setter={pid:first.setter,created:first.setterCreated};
    const path=twin.events[0]!.path;
    let previous=suspend.now;
    for (const e of events) {
      requireValue(e.mode===mode && e.nonce===expected.nonce && e.helper===expected.helper.pid && e.helperCreated===expected.helper.created &&
        e.root===expected.root.pid && e.created===expected.root.created && e.tid===root.tid && e.threadCreated===root.threadCreated &&
        e.setter===first.setter && e.setterCreated===first.setterCreated && e.path===path, 'identity/nonce/path');
      requireValue(e.started===first.started && e.started>=suspend.now && e.deadline===Math.min(e.started+5000,root.deadline) &&
        e.now>=previous && e.now>=e.started && e.now<e.deadline, 'original five-second/absolute root deadline'); previous=e.now;
      requireValue(e.status==='0x00000000' && e.error===0 && e.verified===1 && e.processAccess==='0x00101200' && e.mapAccess==='0x00000003' &&
        e.flags===(e.phase.startsWith('duplicate-')?1:0) && e.closed===+(e.phase.startsWith('close-') || e.phase.startsWith('child-close-') || e.phase==='helper-close'), 'native status/rights/closure/inheritance');
    }
    const position=(prefix:string)=>{const found=lines.map((l,i)=>l.startsWith(prefix)?i:-1).filter(i=>i>=0); requireValue(found.length===1,`single actual ${prefix}`); return found[0]!;};
    const phase=(name:string)=>`anchor-overlap phase=${name} `;
    const ordered=(prefixes:string[])=>{const indexes=prefixes.map(position); requireValue(indexes.every((n,i)=>!i||n>indexes[i-1]!), 'actual call ordering');};
    ordered(['retirement-timing phase=suspend ', 'cleanup close=twin-unused-map ', phase('duplicate-process'), phase('duplicate-directory'), phase('start'),
      'anchor-confinement ',phase('close-transfer-process'),phase('close-transfer-directory'),'anchor-topology phase=creator ', 'anchor-topology phase=root ',phase('request'),phase('child-ready'),
      ...(mode==='exclusive'?['cleanup close=retire-named-map ','directory-twin phase=close-create role=attached ',phase('helper-close')]:[]),
      phase('go'),phase('child-set'),'directory-twin phase=set role=attached ',`map-retire live pid=${expected.root.pid} `,
      ...(mode==='held'?['cleanup close=retire-named-map ','directory-twin phase=close-create role=attached ',phase('helper-close')]:[]),
      phase('release'),phase('child-close-directory'),phase('child-close-process'),phase('child-exit'),phase('close-parent-thread'),phase('close-parent-process'),phase('close-parent-job'),
      'anchor-topology phase=closed ',phase('registry-closed'),'anchor-cleanup ','retirement-timing phase=assign ','retirement-timing phase=resume ']);
    requireValue(lines[position('anchor-confinement ')]===`anchor-confinement setter=${first.setter} inherited=2 member=1 private=0 image=1 token=1`, 'pinned setter confinement');
    for (const stage of ['creator','root','closed']) requireValue(lines[position(`anchor-topology phase=${stage} `)]===
      `anchor-topology phase=${stage} setter=${first.setter} created=${first.setterCreated} proved=1 error=0`, 'owned registry barriers');
    const cleanup=lines[position('anchor-cleanup ')]!.match(/^anchor-cleanup setter=(\d+) created=(\d+) acquired=5 closed=5 files-acquired=(\d+) files-closed=(\d+) forced=0 exit=0 error=0$/);
    requireValue(cleanup && Number(cleanup[1])===first.setter && cleanup[2]===first.setterCreated && Number(cleanup[3])>0 && cleanup[3]===cleanup[4], 'all known parent resources and file I/O closed');
    const checkpoint=result.err.match(/^ownership-checkpoint helper=(\d+) wall-ms=(\d+) targets=(\d+) hold-ms=3000\r?$/m);
    const checkpointObservation=result.err.match(/^cleanup checkpoint-map-open=\S+ absent=[01] closed=1 error=0 wall-ms=(\d+) /m);
    const complete=twin.timing!.frames.at(-1)!.now;
    requireValue(checkpoint && checkpointObservation && Number(checkpoint[1])===expected.helper.pid && Number(checkpoint[3])===expected.root.pid &&
      Number.isSafeInteger(Number(checkpoint[2])) && Number.isSafeInteger(Number(checkpointObservation[1])) && Number(checkpoint[2])>=events.at(-1)!.now &&
      Number(checkpointObservation[1])>=Number(checkpoint[2])+3000 && Number(checkpointObservation[1])<=complete, 'setter closure and original three-second checkpoint bounds');
    report.checkpointAt=Number(checkpoint[2]);
    requireValue(!/anchor-overlap-failure|anchor-forced-incomplete/.test(result.err), 'no forced success evidence');
    report.protocolValid=true;
  } catch(error) {report.protocolValid=false; report.error=String(error);}
  return report;
}
/** Existing registries only. Old incarnations or incomplete transfers cannot
 * discharge this setter's references, and late closes do not pass the gate. */
export function corroborateAnchorRegistry(report: AnchorReport, rows: (LedgerRow & {wallMs?:number; error?:number})[], proofs: unknown[]): boolean {
  try {
    requireValue(report.protocolValid && report.setter && report.checkpointAt, 'valid protocol required');
    requireValue(creatorReferencesClosed(report.setter,rows), 'exact setter reference ledger');
    const events=report.anchorEvents, first=events[0]!;
    const acquired=rows.filter(r=>['acquired','transfer-received'].includes(r.event) && r.pid===first.setter && r.incarnation===first.setterCreated);
    const ids=new Set(acquired.map(r=>r.id));
    requireValue(ids.size>0 && !ids.has(undefined), 'known setter acquisitions');
    for (const id of ids) {
      const closed=rows.filter(r=>r.event==='close-result' && r.id===id);
      requireValue(closed.length===1 && closed[0]!.pid===first.setter && closed[0]!.incarnation===first.setterCreated &&
        Number.isSafeInteger(closed[0]!.wallMs) && closed[0]!.wallMs!>=first.started && closed[0]!.wallMs!<=report.checkpointAt! && closed[0]!.success && closed[0]!.error===0, 'unique exact registry closes before checkpoint');
    }
    const matching=proofs as {request:TopologyRequest; proof:Membership[]; creatorReferencesClosed?:boolean}[];
    const phases=matching.filter(p=>p.request.nonce===first.nonce && p.request.creator.pid===first.setter && p.request.creator.created===first.setterCreated);
    requireValue(phases.length===3 && phases.map(p=>p.request.phase).join()==='creator,root,closed', 'three exact registry phases');
    for (const p of phases) {
      requireValue(p.request.helper.pid===first.helper && p.request.helper.created===first.helperCreated && p.request.waiting===(report.mode==='held') &&
        (p.request.phase==='creator'?p.request.root===null:p.request.root?.pid===first.root && p.request.root.created===first.created) &&
        proveTopology(p.request,p.proof), 'captured helper/setter/root memberships');
    }
    requireValue(phases[2]!.creatorReferencesClosed===true, 'closed proof');
    report.registryCorroborated=true;
  } catch(error) {report.registryCorroborated=false; report.registryError=String(error);}
  return report.registryCorroborated;
}
export function compareAnchorPair(exclusive: AnchorReport | undefined, held: AnchorReport | undefined) {
  const comparable=!!exclusive && !!held && exclusive.mode==='exclusive' && held.mode==='held' && [exclusive,held].every(r=>
    r.protocolValid && r.prerequisites && r.registryCorroborated && r.unusedAbsencePassed && r.postHelperAbsencePassed && r.timing?.outcome!=='original-map-retained') && held.reproducesBaseline;
  return {comparable, causeConfirmed:false as const, productionAccepted:false as const,
    outcome:!comparable?'inconclusive':exclusive!.cleanupGatesPassed?'overlap-associated-difference':exclusive!.reproducesBaseline?'both-retained':'inconclusive'};
}
