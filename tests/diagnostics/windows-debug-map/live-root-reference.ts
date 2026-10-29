import type {Captured} from './capture.ts';
import {parseRootRequest,validateRootObservations,validateFaultNativeEvidence,type RootRequest,type RootObservation} from './fault-root-reference.ts';
import {measureOwnedRootWindow,validateAssignedFailure,type RootWindowRecord,type RootWindowArm,type MatchedDependencies} from './matched-root-reference.ts';
import {boundLiveReceipt,parseLiveReceipt,validateLiveProof,receiptArtifact,type LiveProof} from './live-root-fence.ts';
import {validateLiveDrain,type LiveDrainProof} from './live-root-drain.ts';
export interface LiveArmInput {stdoutMarker?:string;request:RootRequest;ready:Buffer;capturedPid:number;readyObservedAt:number;capture:Promise<Captured>}
export interface LiveArmRecord extends RootWindowArm {stdoutMarker?:string;stdoutPrefix?:string;capturedPid:number;readyObservedAt:number;ready:ReturnType<typeof receiptArtifact>;harnessDrain?:LiveDrainProof;helper?:Captured;captureFinishedAt?:number;helperRelease?:{receipt:ReturnType<typeof receiptArtifact>;publishStartedAt:number;publishFinishedAt:number};returned?:ReturnType<typeof receiptArtifact>;postHelper:RootObservation[];priorCleanupPassed?:boolean}
export interface LiveRootRecord extends RootWindowRecord {arms:Record<'held'|'released',LiveArmRecord>;observationsFinishedAt?:number;helpersJoined:boolean}
export interface LiveDependencies extends MatchedDependencies {
 drainHarness(r:RootRequest):Promise<LiveDrainProof>;
 releaseHelper(r:RootRequest):Promise<{bytes:Buffer;publishStartedAt:number;publishFinishedAt:number}>;readReturn(r:RootRequest):Buffer;
 finish(r:RootRequest,helper:Captured):Promise<{postHelper:RootObservation[];priorCleanupPassed:boolean}>;
}
const roles=['held','released'] as const;
function check(v:unknown,error:string):asserts v {if(!v)throw Error('live root reference: '+error);}
function returnedCapture(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void {
 const r=arm.request,h=arm.helper!,ready=arm.ready.receipt,returned=arm.returned!.receipt,release=arm.helperRelease!;
 validateAssignedFailure({request:r,helper:h,postHelper:arm.postHelper,priorCleanupPassed:arm.priorCleanupPassed!});
 validateFaultNativeEvidence(r,arm.held!.sample!,`pid=${h.pid} exit=${h.code} timedOut=${h.timedOut}\n${h.out}${h.err}`,rows);
 check(arm.priorCleanupPassed===false,'native fatal cleanup remains false');
 check(returned.phase===3&&JSON.stringify({...returned,phase:1,at:ready.at,acquired:0,closed:0})===JSON.stringify(ready),'exact native return receipt');
 const released=parseLiveReceipt(Buffer.from(release.receipt.bytes,'base64'));
 check(released.phase===2&&JSON.stringify({...released,phase:1,at:ready.at})===JSON.stringify(ready)&&release.publishStartedAt===released.at&&release.publishFinishedAt>=released.at&&returned.at>=released.at&&returned.at<=arm.captureFinishedAt!,'ordered helper return');
 const readyLine=`live-fence phase=ready label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} result=125 ready=${ready.ready} deadline=${ready.deadline} root-deadline=${ready.rootDeadline}`;
 const returnLine=`live-fence phase=return label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} result=125 now=${returned.at} acquired=3 closed=3 error=0`;
 const lines=h.err.split(/\r?\n/),index=lines.indexOf(readyLine);
 check(index>0&&lines.filter(l=>l===readyLine).length===1&&lines.filter(l=>l===returnLine).length===1&&lines.indexOf(returnLine)>index&&!h.err.includes('live-fence phase=failed'),'complete native fence transcript');
 for(const prefix of ['caller snapshot=after ','cleanup close=root-thread closed=1 error=0','cleanup close=root-process closed=1 error=0','cleanup close=job closed=1 error=0',`cleanup retired-open phase=final status=0x00000000 absent=0 closed=1 error=0 path=${r.names.retired}`,'execution.windows.routing.cleanup.final-map: native call failed (13); no unprotected fallback'])
  check(lines.some((line,i)=>i<index&&line.startsWith(prefix)),'final cleanup before READY: '+prefix);
 for(const required of [...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),...['station-restore','desktop','station'].map(action=>`window-cleanup action=${action} success=1 error=0`)])check(lines.filter(l=>l===required).length===1&&lines.indexOf(required)<index,'successful stream/window cleanup before READY');
 for(const line of ['live-fence io=ready write=1 acquired=1 closed=1 error=0','live-fence io=release write=0 acquired=2 closed=2 error=0','live-fence io=return write=1 acquired=3 closed=3 error=0'])check(lines.filter(l=>l===line).length===1,'balanced fence I/O');
 validateRootObservations(r.names,arm.postHelper);
}
/** Never manufacture a completed capture for admission. Both native captures
 * stay owned and join even when the shared observation window rejects. */
export interface FencedRootProtocol {
 label(k:'held'|'released'):RootRequest['label'];bound:typeof boundLiveReceipt;artifact:typeof receiptArtifact;
 validateProof:typeof validateLiveProof;returned(arm:LiveArmRecord,rows:ReturnType<LiveDependencies['rows']>):void;
 strategy:'root-overlap'|'both-released';
}
export async function measureLiveRootReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies):Promise<LiveRootRecord> {
 return measureFencedRootReferences(inputs,deps,{label:k=>`ASSIGNED-LIVE-${k.toUpperCase()}` as RootRequest['label'],bound:boundLiveReceipt,artifact:receiptArtifact,validateProof:validateLiveProof,returned:returnedCapture,strategy:'root-overlap'});
}
export async function measureFencedRootReferences(inputs:Record<'held'|'released',LiveArmInput>,deps:LiveDependencies,protocol:FencedRootProtocol):Promise<LiveRootRecord> {
 const record:LiveRootRecord={arms:Object.fromEntries(roles.map(k=>[k,{request:inputs[k].request,...(inputs[k].stdoutMarker!==undefined?{stdoutMarker:inputs[k].stdoutMarker}:{}),capturedPid:inputs[k].capturedPid,readyObservedAt:inputs[k].readyObservedAt,ready:{bytes:inputs[k].ready.toString('base64'),sha256:'',receipt:{}},baseline:[],comparison:[],final:[],postHelper:[]}])) as unknown as LiveRootRecord['arms'],deadline:inputs.held.request.deadline,otherReferencesDrained:false,finalDrained:false,protocolValid:false,outcome:'inconclusive',causeConfirmed:false,productionAccepted:false,helpersJoined:false};
 const completed=new Set<string>(),proofs=new Map<string,LiveProof>(),errors:string[]=[];
 const captures=roles.map(async k=>{try{const h=await inputs[k].capture;record.arms[k].helper=h;record.arms[k].captureFinishedAt=deps.now();return h;}finally{completed.add(k);}});
 // Capture rejections cannot become unhandled while observers are running.
 for(const capture of captures)void capture.catch(()=>{});
 const live=()=>{check(!completed.size,'helper returned before observation/final release');check(deps.now()<record.deadline,'one live deadline');};
 const admit=()=>{
  live();for(const k of roles){const arm=record.arms[k];parseRootRequest(JSON.stringify(arm.request),deps.now());check(arm.request.label===protocol.label(k)&&arm.capturedPid===arm.request.helper.pid,'exact live role/captured helper');check(arm.readyObservedAt>=arm.ready.receipt.ready&&arm.readyObservedAt<=deps.now(),'observed native READY');protocol.bound(arm.request,inputs[k].ready,deps.now());}
 };
 const validateDrains=()=>{const rows=deps.rows(),now=deps.now();for(const k of roles)validateLiveDrain(record.arms[k].request,record.arms[k].harnessDrain!,inputs[k].ready,rows,now);};
 let baselineChecked=false;
 let windowValid=false;
 try {
  for(const k of roles)record.arms[k].ready=protocol.artifact(inputs[k].ready);
  admit();
  const drained=await Promise.allSettled(roles.map(async k=>{live();record.arms[k].harnessDrain=await deps.drainHarness(record.arms[k].request);live();}));
  check(drained.every(r=>r.status==='fulfilled'),'both harness owner drains joined: '+drained.flatMap(r=>r.status==='rejected'?[String(r.reason)]:[]).join('; '));
  await measureOwnedRootWindow(record,{...deps,
   exchange:async r=>{live();const reply=await deps.exchange(r);live();protocol.validateProof(r,reply.live,deps.now());check(reply.live.ready===inputs[r.label===protocol.label('held')?'held':'released'].ready.toString('base64'),'original private READY');
    const previous=proofs.get(r.label);if(previous)check(JSON.stringify(previous.helper)===JSON.stringify(reply.live.helper),'same live helper custody');proofs.set(r.label,reply.live);return reply;},
   observe:async(r,path,phase,deadline)=>{live();if(phase==='baseline'&&!baselineChecked){validateDrains();baselineChecked=true;}const result=await deps.observe(r,path,phase,deadline);live();return result;},
  },()=>{
   admit();validateDrains();
  },protocol.strategy);
  windowValid=record.protocolValid;record.protocolValid=false;record.observationsFinishedAt=deps.now();
  if(!windowValid)errors.push(record.error??'invalid shared window');
 }catch(error){errors.push(String(error));}
 finally {
  // The shared core has joined every baseline/comparison/final observer before
  // this path can publish a helper release. Never retry a consumed fence file.
  const releases=await Promise.allSettled(roles.map(async k=>{
   const arm=record.arms[k];parseRootRequest(JSON.stringify(arm.request),deps.now());protocol.bound(arm.request,inputs[k].ready,deps.now());
   check(!completed.has(k),'helper already returned');const release=await deps.releaseHelper(arm.request);arm.helperRelease={receipt:protocol.artifact(release.bytes),publishStartedAt:release.publishStartedAt,publishFinishedAt:release.publishFinishedAt};
  }));
  for(const r of releases)if(r.status==='rejected')errors.push(String(r.reason));
  const captured=await Promise.allSettled(captures);record.helpersJoined=true;
  const finished=await Promise.allSettled(roles.map(async(k,i)=>{
   const arm=record.arms[k],result=captured[i]!;check(result.status==='fulfilled','original capture joined successfully');
   // Preserve post-exit observations even if a return receipt is malformed.
   const evidence=await deps.finish(arm.request,result.value);arm.postHelper=evidence.postHelper;arm.priorCleanupPassed=evidence.priorCleanupPassed;
   arm.returned=protocol.artifact(deps.readReturn(arm.request));check(arm.helperRelease&&arm.returned.receipt.at>=record.observationsFinishedAt!,'helper returned after all observations');protocol.returned(arm,deps.rows());
  }));
  for(const r of finished)if(r.status==='rejected')errors.push(String(r.reason));
 }
 record.protocolValid=windowValid&&errors.length===0;
 if(!record.protocolValid){record.outcome='inconclusive';record.error=errors.join('; ');}return record;
}
