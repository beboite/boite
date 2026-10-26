import {test,expect} from 'bun:test';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveRootDrainer,validateLiveDrain} from './live-root-drain.ts';
import {encodeLiveReceipt} from './live-root-fence.ts';
import {instrumentJobs,jobsPath} from './ownership-generate.ts';
import type {RootOwned,RootRequest} from './fault-root-reference.ts';

function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'boite-live-drain-')),now=Date.now(),label='ASSIGNED-LIVE-HELD',threadId='lpac-ANCHOR-FAULT-'+label;
 const map='\\Sessions\\2\\BaseNamedObjects\\boite.route.11';
 const request:RootRequest={version:1,compiler:'sdk',compilerNonce:'a'.repeat(32),nonce:'b'.repeat(32),label,phase:'held',helper:{pid:11,created:'101'},root:{pid:21,created:'201'},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline:now+3000,reference:null};
 const bytes=encodeLiveReceipt({version:1,phase:1,role:1,session:2,cleanup:511,result:125,helper:11,root:21,helperCreated:'101',rootCreated:'201',ready:now,deadline:request.deadline,rootDeadline:now+15000,at:now,nonce:request.nonce,compilerNonce:request.compilerNonce,acquired:0,closed:0,error:0});
 writeFileSync(join(directory,label+'.ready.bin'),bytes);
 const owned=(pid:number,created:string,exitCode:number):RootOwned=>({owner:'harness-owner',role:'harness-main',id:'harness/'+pid,threadId,threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,handle:pid+100,pid,created,exitCode,complete:true,closeFailed:false,stage:'tracked'});
 const refs=new Map([[11,owned(11,'101',259)],[21,owned(21,'201',125)]]),tracked=new Map<number,any>(),jobs=new Map([[threadId,{handle:7,key:3}]]),rows:any[]=[],closes=new Map();
 for(const x of refs.values()){
  tracked.set(x.pid,{handle:x.handle,threadId,identity:{incarnation:x.created}});
  rows.push({event:'acquired',...x,incarnation:x.created},{event:'owned-membership',...x,threadMember:1});
 }
 let calls=0,lastError=77;const reads=new Map<number,number>();let beforeRead:((pid:number,n:number)=>void)|undefined;
 const trace={owner:'harness-owner',role:'harness-main',preserve:<T>(fn:()=>T):T=>{const saved=lastError;try{return fn();}finally{lastError=saved;}},
  reference:(handle:number)=>{const x=[...refs.values()].find(x=>x.handle===handle);if(!x)return;
   const n=(reads.get(x.pid)??0)+1;reads.set(x.pid,n);beforeRead?.(x.pid,n);lastError=999;
   return {entry:{id:x.id,pid:x.pid,incarnation:x.created,stage:x.stage,closeFailed:x.closeFailed},identity:{pid:x.pid,incarnation:x.created,exitCode:x.exitCode},complete:x.complete};},
  closeResult:(id:string)=>closes.get(id)};
 const generated=instrumentJobs(readFileSync(jobsPath,'utf8'),join(directory,'unused-worker.ts'));
 const source=generated.slice(generated.indexOf('// Runs only in the hash-pinned harness owner;')).replace('export function','function');
 const factory=new Function('LiveRootDrainer','readFileSync','join','traceRows','ownershipTrace','tracked','threadJobs','globalJob','nestingRefused','reportExit',new Bun.Transpiler({loader:'ts'}).transformSync(source)+'\nreturn ownershipDrainLiveRoot;');
 const exported=factory(LiveRootDrainer,readFileSync,join,()=>rows,trace,tracked,jobs,8,false,(tid:string,pid:number)=>{
  calls++;expect(tid).toBe(threadId);expect(pid).toBe(21);const x=refs.get(pid)!;
  const close={id:x.id,success:true,error:0,wallMs:Date.now()};rows.push({event:'close-result',...close,pid,incarnation:x.created,owner:x.owner,role:x.role,stage:x.stage});tracked.delete(pid);closes.set(x.id,close);lastError=6;
 });
 const drainer=exported('sdk',request.compilerNonce,directory,'unused-trace') as LiveRootDrainer;
 return {directory,request,bytes,refs,tracked,jobs,rows,trace,drainer,closes,reads,get calls(){return calls;},get lastError(){return lastError;},set beforeRead(f:typeof beforeRead){beforeRead=f;},cleanup(){rmSync(directory,{recursive:true,force:true});}};
}

test('real hash-pinned harness export closes only its captured terminal root and preserves the helper and last error',()=>{
 const f=fixture();try{
  const proof=f.drainer.drain(f.request);validateLiveDrain(f.request,JSON.parse(JSON.stringify(proof)),f.bytes,f.rows,Date.now());
  expect(f.calls).toBe(1);expect(f.tracked.has(21)).toBe(false);expect(f.tracked.has(11)).toBe(true);expect(f.refs.get(11)!.exitCode).toBe(259);expect(f.lastError).toBe(77);
  expect(JSON.stringify(proof)).not.toContain('handle');expect(proof.root.threadId).toBe('lpac-ANCHOR-FAULT-ASSIGNED-LIVE-HELD');
  expect(()=>f.drainer.drain(f.request)).toThrow('consumed');expect(f.calls).toBe(1);
 }finally{f.cleanup();}
});

test('identity, ledger, role, helper and job rejection cannot call reportExit or retry a consumed drain',()=>{
 const mutations=[
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.created='999';},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.id='unknown-reference';},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.stage='acquired';},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.complete=false;},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.closeFailed=true;},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(21)!.exitCode=259;},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(11)!.exitCode=125;},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(11)!.created='999';},
  (f:ReturnType<typeof fixture>)=>{f.refs.get(11)!.id='unknown-helper';},
  (f:ReturnType<typeof fixture>)=>{f.trace.role='launcher-main';},
  (f:ReturnType<typeof fixture>)=>{f.tracked.get(21).threadId='lpac-wrong';f.jobs.set('lpac-wrong',{handle:7,key:3});},
  (f:ReturnType<typeof fixture>)=>{f.rows.find(r=>r.event==='owned-membership'&&r.pid===21).jobKey=9;},
  (f:ReturnType<typeof fixture>)=>{f.rows.push({event:'incomplete'});},
  (f:ReturnType<typeof fixture>)=>{f.rows.splice(f.rows.findIndex(r=>r.event==='acquired'&&r.pid===11),1);},
  (f:ReturnType<typeof fixture>)=>{f.rows.push({event:'close-result',id:'harness/21',success:false,error:6});},
 ];
 for(const mutate of mutations){const f=fixture();try{mutate(f);expect(()=>f.drainer.drain(f.request)).toThrow();expect(f.calls).toBe(0);expect(()=>f.drainer.drain(f.request)).toThrow('consumed');expect(f.calls).toBe(0);}finally{f.cleanup();}}
});

test('root or live-helper custody changed during final captured rereads never closes a reused value',()=>{
 for(const [pid,n] of [[21,2],[11,2],[21,3],[11,3]]){const f=fixture();try{
  f.beforeRead=(p,read)=>{if(p===pid&&read===n)f.refs.get(pid)!.id='reused-reference';};
  expect(()=>f.drainer.drain(f.request)).toThrow('custody changed');expect(f.calls).toBe(0);
 }finally{f.cleanup();}}
});

test('wrong READY, compiler, deadline and phase fail before any owned close',()=>{
 for(const bad of ['ready','compiler','nonce','deadline','phase']){const f=fixture();try{
  if(bad==='ready'){const bytes=Buffer.from(f.bytes);bytes[80]=bytes[80]!^1;writeFileSync(join(f.directory,f.request.label+'.ready.bin'),bytes);}
  const r=bad==='compiler'?{...f.request,compiler:'mingw'}:bad==='nonce'?{...f.request,compilerNonce:'f'.repeat(32)}:bad==='deadline'?{...f.request,deadline:Date.now()-1}:bad==='phase'?{...f.request,phase:'release' as const}:f.request;
  expect(()=>f.drainer.drain(r)).toThrow();expect(f.calls).toBe(0);
 }finally{f.cleanup();}}
});

test('a failed close or missing slot removal invalidates proof with no second attempt',()=>{
 for(const bad of ['failed','slot','duplicate']){const f=fixture();try{
  const close=f.trace.closeResult;f.trace.closeResult=id=>{const p=close(id);if(bad==='failed')return {...p,success:false,error:6};if(bad==='slot')f.tracked.set(21,{handle:121,threadId:'replacement',identity:{incarnation:'999'}});if(bad==='duplicate')f.rows.push({...f.rows.find(r=>r.event==='close-result')});return p;};
  expect(()=>f.drainer.drain(f.request)).toThrow();expect(f.calls).toBe(1);expect(()=>f.drainer.drain(f.request)).toThrow('consumed');expect(f.calls).toBe(1);
 }finally{f.cleanup();}}
});
