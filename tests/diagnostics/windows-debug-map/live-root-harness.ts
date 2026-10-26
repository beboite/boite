import {existsSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import type {Captured} from './capture.ts';
import {traceRows} from './target-topology.ts';
import {requestRootReference,type RootRequest,type RootObservation} from './fault-root-reference.ts';
import {parseLiveReceipt,encodeLiveReceipt,boundLiveReceipt,type LiveReceipt} from './live-root-fence.ts';
import {measureLiveRootReferences,type LiveArmInput,type LiveDependencies,type LiveRootRecord} from './live-root-reference.ts';
import type {LiveDrainProof} from './live-root-drain.ts';
interface Job {label:string;project:string;marker?:string}
export interface HarnessDependencies<J extends Job> {
 directory:string;compiler:string;compilerNonce:string;trace:string;preserve<T>(f:()=>T):T;
 start(job:J,env:Record<string,string>,spawned:(pid:number)=>void):Promise<Captured>;
 drainHarness(r:RootRequest):Promise<LiveDrainProof>;
 observe(r:RootRequest,path:string,phase:string,deadline:number):Promise<RootObservation>;
 finish(job:J,request:RootRequest|undefined,capture:Captured):Promise<{postHelper:RootObservation[];priorCleanupPassed:boolean}>;
}
function check(v:unknown,s:string):asserts v {if(!v)throw Error('live root harness: '+s);}
const pause=()=>new Promise<void>(r=>setTimeout(r,5));
/** Receipt files are in the controller output tree, outside every LPAC grant.
 * Original captures and post-helper observers remain owned on preparation errors. */
export async function runLiveRootHarness<J extends Job>(jobs:J[],deps:HarnessDependencies<J>) {
 return runFencedRootHarness(jobs,deps,{labels:['ASSIGNED-LIVE-HELD','ASSIGNED-LIVE-RELEASED'],parse:parseLiveReceipt,bound:boundLiveReceipt,encode:encodeLiveReceipt,environment:['BOITE_LIVE_ROOT_FENCE_LABEL','BOITE_LIVE_ROOT_FENCE_DIRECTORY','BOITE_LIVE_ROOT_FENCE_NONCE'],measure:measureLiveRootReferences});
}
interface HarnessProtocol<F extends LiveReceipt> {marker?(job:Job):string;labels:readonly [string,string];parse(b:Buffer):F;bound(r:RootRequest,b:Buffer,now:number):F;encode(f:F):Buffer;environment:readonly [string,string,string];measure(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies):Promise<LiveRootRecord>;failure?(directory:string,label:string):unknown}
export async function runFencedRootHarness<J extends Job,F extends LiveReceipt>(jobs:J[],deps:HarnessDependencies<J>,protocol:HarnessProtocol<F>) {
 check(jobs.length===2&&jobs.every((j,i)=>j.label==='ANCHOR-FAULT-'+protocol.labels[i]),'fixed pair jobs');
 check(isAbsolute(deps.directory)&&/^[a-f0-9]{32}$/.test(deps.compilerNonce),'private controller context');
 const samples=new Map<string,{bytes:Buffer;receipt:F;pid:number;observedAt:number}>(),processed=new Set<string>();
 const failureArtifacts=new Map<string,unknown>();
 const checkFailure=(label:string)=>{const value=protocol.failure?.(deps.directory,label);if(value!==undefined){failureArtifacts.set(label,value);throw Error('native failure receipt '+label);}};
 const releaseAttempted=new Set<string>();let controlDeadline:number|undefined;
 const context=(f:F,deadline:number):RootRequest=>{const map=(f.session?`\\Sessions\\${f.session}`:'')+`\\BaseNamedObjects\\boite.route.${f.helper}`;return {version:1,compiler:deps.compiler,compilerNonce:deps.compilerNonce,nonce:f.nonce,label:protocol.labels[f.role-1] as RootRequest['label'],phase:'held',helper:{pid:f.helper,created:f.helperCreated},root:{pid:f.root,created:f.rootCreated},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline,reference:null};};
 const release=(r:RootRequest)=>deps.preserve(()=>{
  const ready=samples.get(r.label)!.receipt;protocol.bound(r,readFileSync(join(deps.directory,r.label+'.ready.bin')),Date.now());
  const path=join(deps.directory,r.label+'.release.bin');check(!releaseAttempted.has(r.label)&&!existsSync(path),'no release retry');releaseAttempted.add(r.label);
  const publishStartedAt=Date.now(),bytes=protocol.encode({...ready,phase:2,at:publishStartedAt});writeFileSync(path+'.pending',bytes,{flag:'wx'});renameSync(path+'.pending',path);
  return {bytes,publishStartedAt,publishFinishedAt:Date.now()};
 });
 const started:{job:J;label:string;capture:Promise<Captured>;preparation:Promise<{bytes:Buffer;receipt:F;pid:number;observedAt:number}>}[]=[];
 const finish=async(r:RootRequest,h:Captured)=>{const entry=started.find(s=>s.label===r.label)!;processed.add(r.label);return deps.finish(entry.job,r,h);};
 let record:Awaited<ReturnType<typeof measureLiveRootReferences>>|{protocolValid:boolean;outcome:string;error:string;causeConfirmed:false;productionAccepted:false;preparation:unknown[];helpers:unknown[]};
 try {
  for(const job of jobs){
  const label=job.label.slice('ANCHOR-FAULT-'.length);let pid=0,done=false;
  writeFileSync(join(job.project,'release'),'synthetic');
  const capture=deps.start(job,{[protocol.environment[0]]:label,[protocol.environment[1]]:deps.directory,[protocol.environment[2]]:deps.compilerNonce},p=>{pid=p;});
  void capture.finally(()=>{done=true;}).catch(()=>{});
  const preparation=(async()=>{
   const limit=Date.now()+40000,path=join(deps.directory,label+'.ready.bin');
   while(Date.now()<limit){
    deps.preserve(()=>checkFailure(label));check(!done,'helper exited before READY');
    const bytes=deps.preserve(()=>existsSync(path)?readFileSync(path):undefined);
    if(bytes){const f=protocol.parse(bytes),now=Date.now();check(f.phase===1&&f.role===protocol.labels.indexOf(label)+1&&f.helper===pid&&f.compilerNonce===deps.compilerNonce,'exact captured READY');
     protocol.bound(context(f,Math.min(f.deadline,now+3000)),bytes,now);const sample={bytes,receipt:f,pid,observedAt:now};samples.set(label,sample);return sample;}
    await pause();
   }throw Error('live root READY capture bound');
  })();
   void preparation.catch(()=>{});started.push({job,label,capture,preparation});
  }
  const prepared=await Promise.allSettled(started.map(s=>s.preparation));check(prepared.every(r=>r.status==='fulfilled'),'both final READY receipts');
  const deadline=controlDeadline=Math.min(Date.now()+3000,...[...samples.values()].map(s=>s.receipt.deadline));
  const inputs=Object.fromEntries(started.map((s,i)=>{const sample=samples.get(s.label)!;const request=context(sample.receipt,deadline);return [i?'released':'held',{request,...(protocol.marker?{stdoutMarker:protocol.marker(s.job)}:{}),ready:sample.bytes,capturedPid:sample.pid,readyObservedAt:sample.observedAt,capture:s.capture}];})) as unknown as Record<'held'|'released',LiveArmInput>;
  record=await protocol.measure(inputs,{now:Date.now,rows:()=>deps.preserve(()=>traceRows(deps.trace)),exchange:r=>requestRootReference(deps.directory,r,deps.preserve),observe:deps.observe,drainHarness:deps.drainHarness,
   releaseHelper:async r=>release(r),readReturn:r=>deps.preserve(()=>{checkFailure(r.label);return readFileSync(join(deps.directory,r.label+'.return.bin'));}),finish});
 }catch(error){record={protocolValid:false,outcome:'inconclusive',error:String(error),causeConfirmed:false,productionAccepted:false,preparation:[...samples].map(([label,s])=>({label,receipt:s.receipt,bytes:s.bytes.toString('base64'),pid:s.pid,observedAt:s.observedAt})),helpers:[]};}
 finally{
  await Promise.allSettled(started.map(s=>s.preparation));
  if('preparation' in record!)record.preparation=[...samples].map(([label,s])=>({label,receipt:s.receipt,bytes:s.bytes.toString('base64'),pid:s.pid,observedAt:s.observedAt}));
  // Preparation may reject before the controller owns both arms. Discharge only
  // authenticated own fences still in time; otherwise their native bounds end.
  for(const s of started)if(!processed.has(s.label)&&samples.has(s.label)&&!releaseAttempted.has(s.label)&&!existsSync(join(deps.directory,s.label+'.release.bin'))){
   try{const f=samples.get(s.label)!.receipt;release(context(f,controlDeadline??f.deadline));}catch{/* No retry or extension. Original capture still joins. */}
  }
  const captured=await Promise.allSettled(started.map(s=>s.capture));
  const finished=await Promise.allSettled(started.map(async(s,i)=>{const result=captured[i]!;if(result.status==='fulfilled'&&!processed.has(s.label)){
   const sample=samples.get(s.label);if(sample)await finish(context(sample.receipt,sample.receipt.deadline),result.value);
   else await deps.finish(s.job,undefined,result.value);
  }}));
  if('helpers' in record!)record.helpers=captured;
  const nativeErrors:string[]=[];
  if(protocol.failure)for(const s of started)try{deps.preserve(()=>checkFailure(s.label));}catch(error){nativeErrors.push(String(error));}
  if(protocol.failure)Object.assign(record!,{nativeFailures:[...failureArtifacts.values()]});
  const errors=[...nativeErrors,...[...captured,...finished].flatMap(r=>r.status==='rejected'?[String(r.reason)]:[])];if(errors.length){record!.protocolValid=false;record!.outcome='inconclusive';record!.error=(record!.error??'')+'; joined captures/post-exit observers: '+errors.join('; ');}
 }
 return record!;
}
