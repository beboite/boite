import {existsSync,readFileSync,writeFileSync,readdirSync,statSync,renameSync} from 'node:fs';
import type {LiveProof} from './live-root-fence.ts';
import {isActiveLiveLabel as isLiveLabel,validateActiveProof as validateLiveProof} from './live-fence-dispatch.ts';
import {join} from 'node:path';
import type {LedgerRow,ProcessIdentity,Membership} from './target-topology.ts';

export type FaultLabel='NONCE'|'EARLY-RELEASE'|'ASSIGNED'|'RELEASE'|'STALL'|'ASSIGNED-PAIR-HELD'|'ASSIGNED-PAIR-RELEASED'|'ASSIGNED-LIVE-HELD'|'ASSIGNED-LIVE-RELEASED'|'ASSIGNED-STDIO-HELD'|'ASSIGNED-STDIO-CLOSED'|'ASSIGNED-STDOUT-SILENT'|'ASSIGNED-STDOUT-WRITE'|'ASSIGNED-ZERO-SILENT'|'ASSIGNED-ZERO-WRITE'|'ASSIGNED-BYTE-SILENT'|'ASSIGNED-BYTE-WRITE'|'ASSIGNED-PIPE-HELD'|'ASSIGNED-PIPE-CLOSED';
export interface RootCustody {owner:string;id:string;threadId:string;threadJob:string;jobKey:number;globalJob:string;nestingRefused:boolean}
export interface RootRequest {version:1;compiler:string;compilerNonce:string;nonce:string;label:FaultLabel;phase:'held'|'verified'|'release';helper:ProcessIdentity;root:ProcessIdentity;names:{map:string;retired:string;unused:string};deadline:number;reference:RootCustody|null}
export interface RootClose {id:string;success:boolean;error:number;wallMs:number}
export interface RootReply {request:RootRequest;sample:RootCustody|null;close:RootClose|null;at:number;error:string|null;live?:LiveProof}
export interface RootOwned extends RootCustody {handle:number;pid:number;created:string;exitCode:number|null;role:string;complete:boolean;closeFailed:boolean;stage:string}
export interface RootOwnerDependencies {compiler:string;compilerNonce:string;now():number;current(pid:number):RootOwned|undefined;removed(pid:number):boolean;authorize(request:RootRequest,sample:RootOwned):void;authorizeLive?(request:RootRequest,sample:RootOwned):LiveProof;retire(sample:RootOwned):RootClose|undefined}
const labels=['NONCE','EARLY-RELEASE','ASSIGNED','RELEASE','STALL','ASSIGNED-PAIR-HELD','ASSIGNED-PAIR-RELEASED','ASSIGNED-LIVE-HELD','ASSIGNED-LIVE-RELEASED','ASSIGNED-STDIO-HELD','ASSIGNED-STDIO-CLOSED','ASSIGNED-STDOUT-SILENT','ASSIGNED-STDOUT-WRITE','ASSIGNED-ZERO-SILENT','ASSIGNED-ZERO-WRITE','ASSIGNED-BYTE-SILENT','ASSIGNED-BYTE-WRITE','ASSIGNED-PIPE-HELD','ASSIGNED-PIPE-CLOSED'];
function requireValue(value:unknown,error:string):asserts value {if(!value)throw new Error('fault root reference: '+error);}
function keys(value:unknown,expected:string[]):asserts value is Record<string,unknown> {requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join()===expected.sort().join(),'exact fields');}
function identity(value:unknown):asserts value is ProcessIdentity {keys(value,['pid','created']);requireValue(Number.isSafeInteger(value.pid)&&Number(value.pid)>0&&Number(value.pid)<=0xffffffff&&typeof value.created==='string'&&/^[1-9]\d{0,19}$/.test(value.created),'identity');}
function custody(value:unknown):asserts value is RootCustody {keys(value,['owner','id','threadId','threadJob','jobKey','globalJob','nestingRefused']);requireValue(['owner','id','threadId'].every(k=>typeof value[k]==='string'&&String(value[k]).length>0&&String(value[k]).length<200)&&typeof value.threadJob==='string'&&typeof value.globalJob==='string'&&/^[1-9]\d*$/.test(String(value.threadJob))&&/^(0|[1-9]\d*)$/.test(String(value.globalJob))&&Number.isSafeInteger(value.jobKey)&&Number(value.jobKey)>0&&typeof value.nestingRefused==='boolean','custody');}
export function parseRootRequest(text:string,now:number):RootRequest {
 requireValue(Buffer.byteLength(text)<=8192,'oversized request');const r=JSON.parse(text);keys(r,['version','compiler','compilerNonce','nonce','label','phase','helper','root','names','deadline','reference']);
 requireValue(r.version===1&&typeof r.compiler==='string'&&['sdk','mingw'].includes(r.compiler)&&typeof r.compilerNonce==='string'&&/^[a-f0-9]{32}$/.test(r.compilerNonce)&&typeof r.nonce==='string'&&/^[a-f0-9]{32}$/.test(r.nonce)&&typeof r.label==='string'&&labels.includes(r.label)&&typeof r.phase==='string'&&['held','verified','release'].includes(r.phase),'context');
 identity(r.helper);identity(r.root);requireValue(r.helper.pid!==r.root.pid,'distinct identities');
 keys(r.names,['map','retired','unused']);const map=r.names.map;requireValue(typeof map==='string'&&new RegExp('^\\\\(?:Sessions\\\\[0-9]+\\\\)?BaseNamedObjects\\\\boite\\.route\\.'+r.helper.pid+'$').test(map)&&r.names.retired===map+'.retired'&&r.names.unused===map+'.unused','owned names');
 requireValue(Number.isSafeInteger(r.deadline)&&Number(r.deadline)>now&&Number(r.deadline)<=now+3000,'absolute deadline');
 if(r.phase==='held')requireValue(r.reference===null,'initial reference');else custody(r.reference);
 return r as unknown as RootRequest;
}
const binding=(r:RootRequest)=>JSON.stringify({...r,phase:'held',reference:null});
const sampleOf=(r:RootOwned):RootCustody=>({owner:r.owner,id:r.id,threadId:r.threadId,threadJob:r.threadJob,jobKey:r.jobKey,globalJob:r.globalJob,nestingRefused:r.nestingRefused});
/** The generated owner invokes this dependency controller; no numeric handle
 * crosses the transport and reportExit remains the sole closure path. */
export class FaultRootOwner {
 private rejected=new Set<string>();
 private sessions=new Map<string,{binding:string;held:RootOwned;phase:string;attempted:boolean;liveHelper?:LiveProof['helper']}>();
 constructor(private deps:RootOwnerDependencies){}
 private read(r:RootRequest):RootOwned {
  const x=this.deps.current(r.root.pid);
  requireValue(x&&x.role==='launcher-main'&&x.threadId==='native-'+r.compiler&&x.pid===r.root.pid&&x.created===r.root.created&&x.exitCode===125&&x.complete&&!x.closeFailed&&x.stage==='tracked'&&Number.isSafeInteger(x.handle)&&x.handle>0,'exact terminal owned root');custody(sampleOf(x));return x;
 }
 handle(value:RootRequest):RootReply {
  try{return this.dispatch(value);}catch(error){if(value&&typeof value.label==='string'&&typeof value.nonce==='string')this.rejected.add(value.label+':'+value.nonce);throw error;}
 }
 private authorize(r:RootRequest,x:RootOwned):LiveProof|undefined {
  if(!isLiveLabel(r.label)){this.deps.authorize(r,x);return undefined;}
  requireValue(this.deps.authorizeLive,'separate live admission unavailable');
  const proof=this.deps.authorizeLive(r,x);validateLiveProof(r,proof,this.deps.now());return proof;
 }
 private dispatch(value:RootRequest):RootReply {
  const r=parseRootRequest(JSON.stringify(value),this.deps.now());requireValue(r.compiler===this.deps.compiler&&r.compilerNonce===this.deps.compilerNonce,'active compiler');
  const key=r.label+':'+r.nonce;requireValue(!this.rejected.has(key),'previous invalid operation');let s=this.sessions.get(key);
  if(r.phase==='held'){
   requireValue(!s,'replayed initial sample');const held=this.read(r);this.authorize(r,held);
   s={binding:binding(r),held:{...held},phase:'held',attempted:false};this.sessions.set(key,s);
  }else requireValue(s&&s.binding===binding(r)&&!s.attempted&&JSON.stringify(r.reference)===JSON.stringify(sampleOf(s.held)),'same authenticated reference');
  const current=this.read(r);requireValue(JSON.stringify(current)===JSON.stringify(s!.held),'custody changed');let live=this.authorize(r,current);
  if(live){if(s!.liveHelper)requireValue(JSON.stringify(s!.liveHelper)===JSON.stringify(live.helper),'live helper custody changed');else s!.liveHelper=live.helper;}
  let close:RootClose|null=null;
  if(r.phase==='release'){
   requireValue(s!.phase==='verified','release before observed sample');s!.attempted=true;
   const exact=this.read(r);requireValue(JSON.stringify(exact)===JSON.stringify(s!.held),'identity changed immediately before release');
   if(isLiveLabel(r.label)){live=this.authorize(r,exact);requireValue(JSON.stringify(s!.liveHelper)===JSON.stringify(live?.helper),'live helper custody changed immediately before release');}
   close=this.deps.retire(exact)??null;
   requireValue(close&&close.id===exact.id&&close.success&&close.error===0&&close.wallMs>=this.deps.now()-3000&&close.wallMs<r.deadline&&this.deps.removed(r.root.pid),'actual reportExit closure and slot removal');
  }else if(r.phase==='verified'){requireValue(s!.phase==='held','replayed observation');s!.phase='verified';}
  requireValue(this.deps.now()<r.deadline,'late operation');
  return {request:r,sample:sampleOf(current),close,at:this.deps.now(),error:null,...(live?{live}:{})};
 }
}
export function validateFaultNativeEvidence(r:RootRequest,x:RootCustody,raw:string,rows:(LedgerRow&Partial<Membership>&{exitCode?:number})[]):void {
 requireValue(raw.startsWith(`pid=${r.helper.pid} exit=125 timedOut=false\n`)&&raw.includes('cleanup job-active=0')&&!raw.includes('anchor-forced-incomplete'),'completed helper job zero');
 const frame=raw.match(/^retirement-timing phase=start .* nonce=(\w+) helper=(\d+) helper-created=(\d+) root=(\d+) created=(\d+) /m);
 requireValue(frame&&frame[1]===r.nonce&&Number(frame[2])===r.helper.pid&&frame[3]===r.helper.created&&Number(frame[4])===r.root.pid&&frame[5]===r.root.created,'native captured topology identity');
 requireValue(raw.includes(`private-map path=${r.names.map} create=0x00000000`)&&raw.includes(`map-retire named path=${r.names.retired} create=0x00000000`)&&raw.split(/\r?\n/).some(line=>line.startsWith('directory-twin phase=create role=unused ')&&line.includes(` path=${r.names.unused} `)&&line.includes(' status=0x00000000 ')),'exact created names');
 for(const p of [r.helper,r.root])requireValue(rows.some(v=>v.event==='owned-membership'&&v.role==='launcher-main'&&v.owner===x.owner&&v.pid===p.pid&&v.created===p.created&&v.threadId===x.threadId&&v.threadJob===x.threadJob&&v.jobKey===x.jobKey&&v.globalJob===x.globalJob&&v.nestingRefused===x.nestingRefused&&v.threadMember===1),'captured owner memberships');
 requireValue(!rows.some(v=>v.event==='incomplete'),'complete global trace');
}
export function otherRootReferencesDrained(r:RootRequest,s:RootCustody,rows:(LedgerRow&{error?:number})[],released=false):boolean {
 if(rows.some(v=>v.event==='incomplete'))return false;
 const acquired=rows.filter(v=>['acquired','transfer-received'].includes(v.event)&&v.pid===r.root.pid&&v.incarnation===r.root.created);
 if(!['launcher-main','harness-main'].every(role=>acquired.some(v=>v.role===role))||!acquired.some(v=>v.id===s.id&&v.owner===s.owner&&v.role==='launcher-main'))return false;
 const ids=new Set(acquired.map(v=>v.id));if(ids.has(undefined))return false;
 return [...ids].every(id=>{const close=rows.filter(v=>v.event==='close-result'&&v.id===id);return (id===s.id&&!released?close.length===0:close.length===1&&close[0]!.success===true&&close[0]!.error===0&&close[0]!.pid===r.root.pid&&close[0]!.incarnation===r.root.created)&&(!rows.some(v=>v.event==='transfer-send'&&v.transfer?.id===id)||rows.some(v=>v.event==='transfer-received'&&v.id===id));});
}
export type Preserve=<T>(action:()=>T)=>T;
function publish(path:string,text:string):void {requireValue(!existsSync(path),'replayed file');writeFileSync(path+'.pending',text,{flag:'wx'});renameSync(path+'.pending',path);}
const pause=()=>new Promise<void>(resolve=>setTimeout(resolve,5));
function readBounded(path:string):string {requireValue(statSync(path).size<=16384,'oversized frame');return readFileSync(path,'utf8');}
/** Single active compiler, no outstanding service work after stop resolves. */
export function startFaultRootService(directory:string,owner:FaultRootOwner,preserve:Preserve) {
 let stopped=false;const consumed=new Set<string>();
 const done=(async()=>{while(!stopped){preserve(()=>{
  for(const file of readdirSync(directory).filter(f=>/^(?:NONCE|EARLY-RELEASE|ASSIGNED|RELEASE|STALL|ASSIGNED-PAIR-HELD|ASSIGNED-PAIR-RELEASED|ASSIGNED-LIVE-HELD|ASSIGNED-LIVE-RELEASED|ASSIGNED-STDIO-HELD|ASSIGNED-STDIO-CLOSED|ASSIGNED-STDOUT-SILENT|ASSIGNED-STDOUT-WRITE|ASSIGNED-ZERO-SILENT|ASSIGNED-ZERO-WRITE|ASSIGNED-BYTE-SILENT|ASSIGNED-BYTE-WRITE|ASSIGNED-PIPE-HELD|ASSIGNED-PIPE-CLOSED)\.(?:held|verified|release)\.request\.json$/.test(f))){
   if(consumed.has(file))continue;consumed.add(file);const path=join(directory,file);let request:RootRequest|undefined;
   try{request=parseRootRequest(readBounded(path),Date.now());requireValue(file===`${request.label}.${request.phase}.request.json`,'request filename');const reply=owner.handle(request);publish(path.replace('.request.json','.response.json'),JSON.stringify(reply));}
   catch(error){publish(path.replace('.request.json','.response.json'),JSON.stringify({request:request??null,sample:null,close:null,error:String(error),at:Date.now()}));}
  }
 });await pause();}})();void done.catch(()=>{});
 return {stop:async()=>{stopped=true;await done;}};
}
export async function requestRootReference(directory:string,r:RootRequest,preserve:Preserve):Promise<RootReply> {
 preserve(()=>{parseRootRequest(JSON.stringify(r),Date.now());publish(join(directory,`${r.label}.${r.phase}.request.json`),JSON.stringify(r));});
 const path=join(directory,`${r.label}.${r.phase}.response.json`);
 while(Date.now()<r.deadline){
  const text=preserve(()=>existsSync(path)?readBounded(path):undefined);
  if(text!==undefined){const reply=JSON.parse(text);keys(reply,['request','sample','close','at','error',...(isLiveLabel(r.label)&&reply.error===null?['live']:[])]);requireValue(JSON.stringify(reply.request)===JSON.stringify(r)&&Number.isSafeInteger(reply.at)&&Number(reply.at)<r.deadline&&Number(reply.at)>=r.deadline-3000&&Number(reply.at)<=Date.now(),'authenticated reply');if(reply.error!==null){requireValue(typeof reply.error==='string'&&reply.sample===null&&reply.close===null,'strict error response');throw new Error(reply.error);}custody(reply.sample);requireValue(r.phase==='held'||JSON.stringify(reply.sample)===JSON.stringify(r.reference),'same response custody');
   if(r.phase==='release'){keys(reply.close,['id','success','error','wallMs']);requireValue(reply.close.id===r.reference?.id&&reply.close.success===true&&reply.close.error===0&&Number.isSafeInteger(reply.close.wallMs)&&Number(reply.close.wallMs)<r.deadline,'close proof');}else requireValue(reply.close===null,'early closure');
   if(isLiveLabel(r.label))validateLiveProof(r,reply.live,Date.now());
   return reply as unknown as RootReply;}
  await pause();
 }throw new Error('fault root reference absolute deadline');
}

export interface RootObservation {path:string;code:number|null;timedOut:boolean;out:string;err:string}
export interface RootControlRecord {request:RootRequest;held?:RootReply;verified?:RootReply;released?:RootReply;before:RootObservation[];after:RootObservation[];otherReferencesDrained:boolean;protocolValid:boolean;outcome:string;error?:string;causeConfirmed:false;productionAccepted:false}
function exactRootObservation(r:RootObservation,path:string):boolean {
 if(r.path!==path||r.code!==0||r.timedOut)return false;
 if(r.out===`map-after-helper-exit path=${path} open=0xc0000034 absent=1 closed=1 error=0\r\n`)return r.err==='';
 if(r.out!==`map-after-helper-exit path=${path} open=0x00000000 absent=0 closed=1 error=0\r\n`)return false;
 // A successful open emits object_counts and close_owned evidence on stderr.
 // Accept only those exact successful records, including the query-only grant.
 const cleanup=r.err.match(/^cleanup object=map-post-exit-observer handle=([0-9a-fA-F]{16}) query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=[1-9]\d* pointers=[1-9]\d*\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n$/);
 return !!cleanup&&BigInt('0x'+cleanup[1])>0n;
}
export function validateRootObservations(names:RootRequest['names'],result:RootObservation[]):void {
 requireValue(result.length===3,'three owned observers');
 for(const [i,r] of result.entries())requireValue(exactRootObservation(r,Object.values(names)[i]!),'exact observer output');
}
export async function observeRootBatch(request:RootRequest,phase:string,deps:{observe(path:string,phase:string,deadline:number):Promise<RootObservation>;now():number}):Promise<RootObservation[]> {
  requireValue(deps.now()<request.deadline,'observer deadline');
  const settled=await Promise.allSettled(Object.values(request.names).map(path=>deps.observe(path,phase,request.deadline)));
  const result:RootObservation[]=[];
  for(const r of settled){if(r.status==='fulfilled')result.push(r.value);}
  requireValue(settled.every(r=>r.status==='fulfilled')&&result.length===3,'all observers joined successfully');
  validateRootObservations(request.names,result);
  requireValue(deps.now()<request.deadline,'late observer');return result;
}
export async function measureFaultRootReference(request:RootRequest,deps:{exchange(r:RootRequest):Promise<RootReply>;observe(path:string,phase:string,deadline:number):Promise<RootObservation>;rows(): (LedgerRow&{error?:number})[];now():number}):Promise<RootControlRecord> {
 const record:RootControlRecord={request,before:[],after:[],otherReferencesDrained:false,protocolValid:false,outcome:'inconclusive',causeConfirmed:false,productionAccepted:false};
 const observations=(phase:string)=>observeRootBatch(request,phase,deps);
 try {
  record.held=await deps.exchange(request);requireValue(record.held.sample,'held custody');
  while(deps.now()<request.deadline&&!otherRootReferencesDrained(request,record.held.sample,deps.rows()))await pause();
  record.otherReferencesDrained=otherRootReferencesDrained(request,record.held.sample,deps.rows());requireValue(record.otherReferencesDrained,'other root references drained before observation');
  record.before=await observations('held');
  const bound={...request,reference:record.held.sample};record.verified=await deps.exchange({...bound,phase:'verified'});
  requireValue(otherRootReferencesDrained(request,record.held.sample,deps.rows()),'other root references remained drained during observation');
  record.released=await deps.exchange({...bound,phase:'release'});record.after=await observations('released');requireValue(otherRootReferencesDrained(request,record.held.sample,deps.rows(),true),'complete post-release registry evidence');record.protocolValid=true;
  const retained=record.before.filter(r=>r.out.includes('absent=0'));
  record.outcome=!retained.length?'inconclusive':retained.every(r=>record.after.find(a=>a.path===r.path)?.out.includes('absent=1'))?'disappearance-after-owned-release':'retained-after-owned-release';
 }catch(error){record.error=String(error);}
 return record;
}
