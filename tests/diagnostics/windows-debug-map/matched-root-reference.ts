import type {Captured} from './capture.ts';
import type {LedgerRow} from './target-topology.ts';
import {parseRootRequest,observeRootBatch,validateRootObservations,otherRootReferencesDrained,type RootRequest,type RootReply,type RootObservation} from './fault-root-reference.ts';

type Arm='held'|'released';
type Rows=(LedgerRow&{error?:number;wallMs?:number})[];
export interface MatchedArmInput {request:RootRequest;helper:Captured;postHelper:RootObservation[];priorCleanupPassed:boolean}
export interface RootWindowArm {request:RootRequest;held?:RootReply;verified?:RootReply;released?:RootReply;baseline:RootObservation[];comparison:RootObservation[];final:RootObservation[]}
export interface MatchedArmRecord extends MatchedArmInput,RootWindowArm {}
export interface RootWindowRecord {
 arms:Record<Arm,RootWindowArm>;deadline:number;comparisonWindow?:{begin:number;end:number};
 otherReferencesDrained:boolean;finalDrained:boolean;protocolValid:boolean;outcome:string;error?:string;causeConfirmed:false;productionAccepted:false;
}
export interface MatchedRootRecord extends RootWindowRecord {arms:Record<Arm,MatchedArmRecord>}
export interface MatchedDependencies {
 now():number;rows():Rows;exchange(r:RootRequest):Promise<RootReply>;
 observe(r:RootRequest,path:string,phase:string,deadline:number):Promise<RootObservation>;
}
const arms:Arm[]=['held','released'];
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
function check(value:unknown,error:string):asserts value {if(!value)throw Error('matched root reference: '+error);}
/** The original assigned failure/cleanup prerequisites remain independent of
 * later observations and cannot clear earlier fatal absence flags. */
export function validateAssignedFailure(input:MatchedArmInput):void {
 const r=input.request,h=input.helper,raw=h.err;
 check(h.pid===r.helper.pid&&h.code===125&&!h.timedOut,'completed assigned helper');
 const frame=raw.match(/^retirement-timing phase=start mode=live nonce=(\w+) helper=(\d+) helper-created=(\d+) root=(\d+) created=(\d+) /m);
 check(frame&&frame[1]===r.nonce&&Number(frame[2])===r.helper.pid&&frame[3]===r.helper.created&&Number(frame[4])===r.root.pid&&frame[5]===r.root.created,'native assigned identities');
 check(raw.includes(`anchor-overlap phase=start mode=exclusive nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} `)&&
  raw.includes(`anchor-overlap phase=go mode=exclusive nonce=${r.nonce} `),'same exclusive assigned execution');
 const cleanup=raw.match(/^anchor-cleanup setter=\d+ created=\d+ acquired=5 closed=5 files-acquired=(\d+) files-closed=(\d+) forced=[01] exit=125 error=13\r?$/m);
 check(cleanup&&Number(cleanup[1])>0&&cleanup[1]===cleanup[2]&&raw.includes('cleanup job-active=0')&&
  !raw.includes('anchor-forced-incomplete')&&!/^retirement-timing phase=(assign|resume|release) /m.test(raw),'expected bounded assigned rejection');
 for(const slot of ['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'])
  check(raw.includes(`cleanup close=${slot} closed=1 error=0`),'native '+slot+' closure');
 check(/caller snapshot=after .* unchanged=1/.test(raw)&&typeof input.priorCleanupPassed==='boolean','original caller/cleanup record');
 validateRootObservations(r.names,input.postHelper);
}
function sameJob(a:RootReply,b:RootReply):boolean {
 return !!a.sample&&!!b.sample&&a.sample.id!==b.sample.id&&
  (['owner','threadId','threadJob','jobKey','globalJob','nestingRefused'] as const).every(k=>a.sample![k]===b.sample![k]);
}
function actualClose(arm:RootWindowArm,rows:Rows,after:number):void {
 const proof=arm.released?.close,sample=arm.held?.sample;
 check(proof&&sample&&proof.id===sample.id&&proof.success&&proof.error===0,'owned close proof');
 const matches=rows.filter(r=>r.event==='close-result'&&r.id===sample.id),row=matches[0];
 check(matches.length===1&&row&&row.owner===sample.owner&&row.pid===arm.request.root.pid&&row.incarnation===arm.request.root.created&&
  row.success&&row.error===0&&Number.isSafeInteger(row.wallMs)&&row.wallMs!>after&&row.wallMs!<=proof.wallMs&&proof.wallMs<=arm.released!.at&&arm.released!.at<arm.request.deadline,'actual native closure ordering');
}
/** A failed comparison never grants a replacement closure. Original owners
 * retain teardown custody of any reference not discharged by this protocol. */
export async function measureMatchedRootReferences(inputs:Record<Arm,MatchedArmInput>,deps:MatchedDependencies):Promise<MatchedRootRecord> {
 const record:MatchedRootRecord={arms:{held:{...inputs.held,baseline:[],comparison:[],final:[]},released:{...inputs.released,baseline:[],comparison:[],final:[]}},
  deadline:inputs.held.request.deadline,otherReferencesDrained:false,finalDrained:false,protocolValid:false,outcome:'inconclusive',causeConfirmed:false,productionAccepted:false};
 return measureOwnedRootWindow(record,deps,()=>{
  const now=deps.now();for(const key of arms){const arm=record.arms[key];parseRootRequest(JSON.stringify(arm.request),now);check(arm.request.label===`ASSIGNED-PAIR-${key.toUpperCase()}`,'fixed pair role');validateAssignedFailure(arm);}
 });
}
/** Shared observer/drainage/owned-close protocol; each caller supplies its own
 * admission, without converting live helpers into completed captures. */
export async function measureOwnedRootWindow<T extends RootWindowRecord>(record:T,deps:MatchedDependencies,admit:()=>void,strategy:'root-overlap'|'both-released'='root-overlap'):Promise<T> {
 const both=async<T>(action:(arm:RootWindowArm,key:Arm)=>Promise<T>)=>{
  const settled=await Promise.allSettled(arms.map(key=>action(record.arms[key],key)));
  const errors=settled.filter(s=>s.status==='rejected').map(s=>(s as PromiseRejectedResult).reason);
  check(!errors.length,'both arms joined: '+errors.map(String).join('; '));
 };
 const drained=(released:Arm[]=[])=>{
  const rows=deps.rows();return arms.every(key=>otherRootReferencesDrained(record.arms[key].request,record.arms[key].held!.sample!,rows,released.includes(key)));
 };
 const batch=async(phase:'baseline'|'comparison')=>both(async arm=>{
  arm[phase]=await observeRootBatch(arm.request,phase,{now:deps.now,observe:async(path,p,deadline)=>{
   const result=await deps.observe(arm.request,path,p,deadline);arm[phase].push(result);return result;
  }});
 });
 try {
  admit();
  const a=record.arms.held.request,b=record.arms.released.request;
  check(a.deadline===b.deadline&&a.compiler===b.compiler&&a.compilerNonce===b.compilerNonce&&a.nonce!==b.nonce&&
   new Set([a.helper.pid,a.root.pid,b.helper.pid,b.root.pid]).size===4,'distinct matched contexts and one deadline');
  await both(async arm=>{arm.held=await deps.exchange(arm.request);check(arm.held.sample,'initial custody');});
  check(sameJob(record.arms.held.held!,record.arms.released.held!),'same owned ancestor job');
  while(deps.now()<record.deadline&&!drained())await pause();
  record.otherReferencesDrained=drained();check(record.otherReferencesDrained,'other references before baseline');
  await batch('baseline');
  for(const arm of Object.values(record.arms))check(arm.baseline.filter(o=>o.out.includes('absent=0')).length===1&&
   arm.baseline.find(o=>o.path===arm.request.names.retired)?.out.includes('absent=0'),'same retired retained baseline');
  await both(async arm=>{arm.verified=await deps.exchange({...arm.request,phase:'verified',reference:arm.held!.sample});});
  check(drained(),'references unchanged after baseline');
  if(strategy==='both-released') {
   await both(async arm=>{arm.released=await deps.exchange({...arm.request,phase:'release',reference:arm.held!.sample});actualClose(arm,deps.rows(),arm.verified!.at-1);});
   record.finalDrained=drained(arms);check(record.finalDrained,'both exact roots before stdio comparison');
   const window=record.comparisonWindow={begin:deps.now(),end:0};
   try{await batch('comparison');}finally{window.end=deps.now();}
   check(drained(arms),'both exact roots after stdio comparison');
   for(const arm of Object.values(record.arms))check(arm.comparison.filter(o=>o.path!==arm.request.names.retired).every(o=>o.out.includes('absent=1')),'other comparison names stay absent');
   check(deps.now()<record.deadline,'shared stdio window deadline');
   const h=record.arms.held.comparison.find(o=>o.path===record.arms.held.request.names.retired)!.out.includes('absent=0');
   const c=record.arms.released.comparison.find(o=>o.path===record.arms.released.request.names.retired)!.out.includes('absent=0');
   record.outcome=h&&!c?'stdio-held-retained-closed-absent':h&&c?'both-retained':!h&&!c?'both-absent':'stdio-held-absent-closed-retained';
   record.protocolValid=true;return record;
  }
  const released=record.arms.released,held=record.arms.held;
  released.released=await deps.exchange({...released.request,phase:'release',reference:released.held!.sample});
  actualClose(released,deps.rows(),released.verified!.at-1);
  check(drained(['released']),'HELD custody before shared window');
  const window=record.comparisonWindow={begin:deps.now(),end:0};
  try{await batch('comparison');}finally{window.end=deps.now();}
  check(drained(['released']),'HELD unclosed through shared window');
  for(const arm of Object.values(record.arms))check(arm.comparison.filter(o=>o.path!==arm.request.names.retired).every(o=>o.out.includes('absent=1')),'other comparison names stay absent');
  check(deps.now()<record.deadline,'shared window deadline');
  // Require a later wall-ms tick as well as later source ordering, without
  // resetting the shared deadline for this final native closure.
  while(deps.now()<=window.end&&deps.now()<record.deadline)await pause();
  check(deps.now()<record.deadline,'HELD final release deadline');
  held.released=await deps.exchange({...held.request,phase:'release',reference:held.held!.sample});
  actualClose(held,deps.rows(),window.end);
  record.finalDrained=drained(arms);check(record.finalDrained,'all exact root references discharged');
  held.final=await observeRootBatch(held.request,'final',{now:deps.now,observe:(path,phase,deadline)=>deps.observe(held.request,path,phase,deadline)});
  check(drained(arms),'final registry reconciliation');
  const h=held.comparison.find(o=>o.path===held.request.names.retired)!.out.includes('absent=0');
  const r=released.comparison.find(o=>o.path===released.request.names.retired)!.out.includes('absent=0');
  record.outcome=h&&!r?'held-retained-released-absent':h&&r?'both-retained':!h&&!r?'both-absent':'held-absent-released-retained';
  record.protocolValid=true;
 }catch(error){record.error=String(error);}
 return record;
}
