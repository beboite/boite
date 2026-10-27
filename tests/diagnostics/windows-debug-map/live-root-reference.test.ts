import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FaultRootOwner,startFaultRootService,requestRootReference,validateFaultNativeEvidence,type RootRequest,type RootOwned} from './fault-root-reference.ts';
import {encodeLiveReceipt,parseLiveReceipt,authorizeLiveFence,type LiveReceipt} from './live-root-fence.ts';
import {runLiveRootHarness} from './live-root-harness.ts';
import {measureLiveRootReferences} from './live-root-reference.ts';
const context=(role=1,now=Date.now())=>({version:1,phase:1,role,session:2,cleanup:511,result:125,helper:10+role,root:20+role,helperCreated:String(100+role),rootCreated:String(200+role),ready:now,deadline:now+3000,rootDeadline:now+6000,at:now,nonce:(role===1?'b':'c').repeat(32),compilerNonce:'a'.repeat(32),acquired:0,closed:0,error:0});
function req(f:LiveReceipt):RootRequest {const map=`\\Sessions\\2\\BaseNamedObjects\\boite.route.${f.helper}`;return {version:1,compiler:'sdk',compilerNonce:f.compilerNonce,nonce:f.nonce,label:f.role===1?'ASSIGNED-LIVE-HELD':'ASSIGNED-LIVE-RELEASED',phase:'held',helper:{pid:f.helper,created:f.helperCreated},root:{pid:f.root,created:f.rootCreated},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline:f.deadline,reference:null};}
const owned=(pid:number,created:string,exitCode:number):RootOwned=>({owner:'owner',id:'ref/'+pid,threadId:'native-sdk',threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,handle:pid+100,pid,created,exitCode,role:'launcher-main',complete:true,closeFailed:false,stage:'tracked'});
const members=(r:RootRequest)=>[r.helper,r.root].map(p=>({event:'owned-membership',owner:'owner',role:'launcher-main',...p,threadId:'native-sdk',threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,threadMember:1}));
const cleanup='cleanup object=map-post-exit-observer handle=000000000000018C query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=2 pointers=32772\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n';
const observed=(path:string,absent:boolean)=>({path,code:0,timedOut:false,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${+absent} closed=1 error=0\r\n`,err:absent?'':cleanup});
test('private final receipt binds its bytes, nonce, exact identities, role, final result and original deadline',()=>{
 const f=context(1,1000),bytes=encodeLiveReceipt(f);expect(bytes.length).toBe(232);expect(parseLiveReceipt(bytes)).toEqual(f);
 for(const b of [bytes.subarray(0,231),Buffer.concat([bytes,Buffer.from([0])]),...([0,4,8,20,228] as const).map(i=>{const x=Buffer.from(bytes);x[i]=x[i]!^1;return x;})])expect(()=>parseLiveReceipt(b)).toThrow();
 for(const patch of [{nonce:'x'.repeat(32)},{deadline:4001},{rootDeadline:3999},{at:999},{phase:4},{acquired:1,closed:0}])expect(()=>parseLiveReceipt(encodeLiveReceipt({...f,...patch}))).toThrow();
 const r=req(f),root=owned(f.root,f.rootCreated,125),helper=owned(f.helper,f.helperCreated,259);
 expect(authorizeLiveFence(r,root,helper,bytes,members(r),1001).helper.id).toBe(helper.id);
 for(const patch of [{created:'999'},{exitCode:125},{complete:false},{stage:'acquired'},{id:root.id}])expect(()=>authorizeLiveFence(r,root,{...helper,...patch},bytes,members(r),1001)).toThrow();
 for(const patch of [{nonce:'d'.repeat(32)},{compilerNonce:'e'.repeat(32)},{deadline:4001},{label:'ASSIGNED' as const}])expect(()=>authorizeLiveFence({...r,...patch},root,helper,bytes,members(r),1001)).toThrow();
 expect(()=>authorizeLiveFence(r,root,helper,bytes,members(r).slice(0,1),1001)).toThrow();
 expect(()=>validateFaultNativeEvidence({...r,label:'ASSIGNED'},root,'live ready',members(r))).toThrow();
});

function fixture(separateDirectories=false){
 const artifactDirectory=mkdtempSync(join(tmpdir(),'boite-live-root-')),directory=separateDirectories?join(artifactDirectory,'fault-root-control'):artifactDirectory;
 if(separateDirectories)mkdirSync(directory);
 const rows:any[]=[],roots=new Map<number,RootOwned>(),helpers=new Map<number,RootOwned>(),harness=new Map<number,RootOwned>(),closures:number[]=[],events:string[]=[],returns=new Map<string,Buffer>();
 const started=Date.now(),ready=[context(1,started),context(2,started)],resolve=new Map<string,(value:any)=>void>();
 const arms=Object.fromEntries(ready.map(f=>{
  const request=req(f);roots.set(f.root,owned(f.root,f.rootCreated,125));helpers.set(f.helper,owned(f.helper,f.helperCreated,259));
  rows.push(...members(request),{event:'acquired',owner:'owner',role:'launcher-main',pid:f.root,incarnation:f.rootCreated,id:'ref/'+f.root});
  for(const [p,created,exitCode] of [[f.helper,f.helperCreated,259],[f.root,f.rootCreated,125]] as const){
   const x={...owned(p,created,exitCode),owner:'harness',id:'other/'+p,role:'harness-main',threadId:'lpac-ANCHOR-FAULT-'+request.label,threadJob:String(100+f.role),jobKey:100+f.role};harness.set(p,x);
   rows.push({event:'acquired',...x,incarnation:created},{event:'owned-membership',...x,threadMember:1});
  }
  const bytes=encodeLiveReceipt(f);writeFileSync(join(directory,request.label+'.ready.bin'),bytes);
  const capture=new Promise<any>(r=>resolve.set(request.label,r));return [f.role===1?'held':'released',{request,ready:bytes,capturedPid:f.helper,readyObservedAt:started,capture}];
 })) as any;
 const nativeClose=(pid:number)=>{const x=roots.get(pid)!;roots.delete(pid);const close={id:x.id,success:true,error:0,wallMs:Date.now()};rows.push({event:'close-result',...close,pid,incarnation:x.created,owner:x.owner,role:x.role});return close;};
 const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:'a'.repeat(32),now:Date.now,current:p=>roots.get(p),removed:p=>!roots.has(p),authorize:()=>{throw Error('completed admission used for live');},
  authorizeLive:(r,x)=>authorizeLiveFence(r,x,helpers.get(r.helper.pid),readFileSync(join(directory,r.label+'.ready.bin')),rows,Date.now()),retire:x=>{closures.push(x.pid);events.push('close:'+x.pid);return nativeClose(x.pid);}});
 const releaseHelper=async(r:RootRequest)=>{
  const f=ready.find(f=>f.helper===r.helper.pid)!,at=Date.now(),bytes=encodeLiveReceipt({...f,phase:2,at});writeFileSync(join(directory,r.label+'.release.bin'),bytes);
  const ret=encodeLiveReceipt({...f,phase:3,at:Date.now(),acquired:2,closed:2});returns.set(r.label,ret);writeFileSync(join(directory,r.label+'.return.bin'),ret);
  events.push('helper-release:'+r.helper.pid);helpers.get(r.helper.pid)!.exitCode=125;
  const err=[`retirement-timing phase=start mode=live nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} tid=33`,
   `anchor-overlap phase=start mode=exclusive nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} setter=40`, `anchor-overlap phase=go mode=exclusive nonce=${r.nonce} helper=${r.helper.pid}`,
   `private-map path=${r.names.map} create=0x00000000`,`map-retire named path=${r.names.retired} create=0x00000000`,`directory-twin phase=create role=unused path=${r.names.unused} status=0x00000000 end=1`,
   'anchor-cleanup setter=40 created=300 acquired=5 closed=5 files-acquired=8 files-closed=8 forced=1 exit=125 error=13','cleanup job-active=0',
   ...['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'].map(s=>`cleanup close=${s} closed=1 error=0`),
   ...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),...['station-restore','desktop','station'].map(action=>`window-cleanup action=${action} success=1 error=0`),
   'caller snapshot=after map=x unchanged=1',`cleanup retired-open phase=final status=0x00000000 absent=0 closed=1 error=0 path=${r.names.retired}`,
   'execution.windows.routing.cleanup.final-map: native call failed (13); no unprotected fallback',
   `live-fence io=ready write=1 acquired=1 closed=1 error=0`,
   `live-fence phase=ready label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} result=125 ready=${f.ready} deadline=${f.deadline} root-deadline=${f.rootDeadline}`,
   'live-fence io=release write=0 acquired=2 closed=2 error=0','live-fence io=return write=1 acquired=3 closed=3 error=0',
   `live-fence phase=return label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} result=125 now=${parseLiveReceipt(ret).at} acquired=3 closed=3 error=0`].join('\r\n').replaceAll('\\r\\n','\r\n')+'\r\n';
  resolve.get(r.label)!({pid:r.helper.pid,code:125,timedOut:false,out:'',err});return {bytes,publishStartedAt:at,publishFinishedAt:Date.now()};
 };
 let joined=0,drainer:any;const deps={now:Date.now,rows:()=>rows,exchange:async(r:RootRequest)=>owner.handle(r),
  drainHarness:async(r:RootRequest)=>{
   const {LiveRootDrainer}=await import('./live-root-drain.ts');
   drainer??=new LiveRootDrainer({compiler:'sdk',compilerNonce:'a'.repeat(32),now:Date.now,current:(p:number)=>harness.get(p),ready:(r:RootRequest)=>readFileSync(join(directory,r.label+'.ready.bin')),rows:()=>rows,removed:(p:number)=>!harness.has(p),retire:(x:RootOwned)=>{harness.delete(x.pid);const close={id:x.id,success:true,error:0,wallMs:Date.now()};rows.push({event:'close-result',...close,owner:x.owner,role:x.role,pid:x.pid,incarnation:x.created,stage:'tracked'});events.push('drain:'+x.pid);return close;}});
   return drainer.drain(r);
  },
  observe:async(r:RootRequest,path:string,phase:string)=>{try{await new Promise(res=>setTimeout(res,2));expect(helpers.get(11)!.exitCode).toBe(259);expect(helpers.get(12)!.exitCode).toBe(259);events.push('observe:'+phase);return observed(path,path!==r.names.retired||!roots.has(r.root.pid));}finally{joined++;}},
  releaseHelper,readReturn:(r:RootRequest)=>returns.get(r.label)!,finish:async(r:RootRequest)=>({postHelper:Object.values(r.names).map(path=>observed(path,true)),priorCleanupPassed:false})};
 return {artifactDirectory,directory,arms,deps,roots,helpers,harness,rows,closures,events,resolve,owner,nativeClose,get joined(){return joined;},cleanup(){rmSync(artifactDirectory,{recursive:true,force:true});}};
}
test('live comparison drains both harness references while helpers stay alive instead of waiting for helper exit',async()=>{
 const f=fixture();let drains=0;const drain=f.deps.drainHarness;f.deps.drainHarness=async r=>{drains++;return drain(r);};
 for(const a of Object.values(f.arms) as any[])a.request.deadline=Date.now()+150;
 const timeout=setTimeout(()=>{for(const [label,resolve] of f.resolve)resolve({pid:label.endsWith('-HELD')?11:12,code:125,timedOut:false,out:'',err:'native autonomous fence expired'});},200);
 try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(drains).toBe(2);expect(r.protocolValid).toBe(true);expect(f.events.filter(x=>x.startsWith('drain:'))).toHaveLength(2);expect(f.events.findIndex(x=>x.startsWith('observe:'))).toBeGreaterThan(f.events.lastIndexOf('drain:22'));expect(f.closures).toEqual([22,21]);expect(r.deadline).toBe(f.arms.held.request.deadline);}finally{clearTimeout(timeout);f.cleanup();}
});
test('both harness drain proofs are rechecked on a fresh snapshot before the first baseline observer',async()=>{
 const f=fixture(),drain=f.deps.drainHarness,exchange=f.deps.exchange,proofs=new Map();
 f.deps.drainHarness=async r=>{const p=await drain(r);proofs.set(r.label,p);return p;};
 f.deps.exchange=async r=>{const reply=await exchange(r);if(r.phase==='held'&&r.label.endsWith('-RELEASED'))proofs.get(r.label).removed=false;return reply;};
 try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(f.joined).toBe(0);expect(f.closures).toEqual([]);expect(f.events.filter(e=>e.startsWith('drain:'))).toHaveLength(2);expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});
test('live shared comparison closes roots before either authenticated helper fence release',async()=>{
 const f=fixture();try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.error).toBeUndefined();expect(r.protocolValid).toBe(true);expect(r.outcome).toBe('held-retained-released-absent');expect(f.closures).toEqual([22,21]);expect(f.joined).toBe(15);expect(r.arms.held.helper!.code).toBe(125);expect(r.arms.held.priorCleanupPassed).toBe(false);expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);expect(f.events.indexOf('helper-release:11')).toBeGreaterThan(f.events.lastIndexOf('observe:final'));expect(r.arms.held.held!.live!.helper.exitCode).toBe(259);}finally{f.cleanup();}
});
test('changed live helper identity or early exit forbids substitute root closure',async()=>{
 for(const change of [{created:'999'},{exitCode:125}]){const f=fixture(),observe=f.deps.observe;let mutated=false;
  f.deps.observe=async(r,path,phase)=>{if(phase==='comparison'&&!mutated){mutated=true;Object.assign(f.helpers.get(11)!,change);}return observe(r,path,phase);};
  try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(f.closures).toEqual([22]);expect(r.outcome).toBe('inconclusive');}finally{f.cleanup();}
 }
});
test('all delayed observers join before failure cleanup releases helper fences',async()=>{
 const f=fixture(),observe=f.deps.observe;let settled=0;
 f.deps.observe=async(r,path,phase)=>{if(phase!=='comparison')return observe(r,path,phase);try{await new Promise(res=>setTimeout(res,10));if(path===r.names.map)throw Error('observer rejected');return observed(path,false);}finally{settled++;}};
 const release=f.deps.releaseHelper;f.deps.releaseHelper=async r=>{expect(settled).toBe(6);return release(r);};
 try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(settled).toBe(6);expect(f.closures).toEqual([22]);expect(r.arms.held.helper!.code).toBe(125);}finally{f.cleanup();}
});

test('the actual generated owner export reads live receipts from the private control directory through strict service phases',async()=>{
 const f=fixture(true),tracked=new Map<number,any>(),jobs=new Map([['native-sdk',{handle:7,key:3}]]),proofs=new Map();
 for(const x of [...f.roots.values(),...f.helpers.values()])tracked.set(x.pid,{handle:x.handle,threadId:x.threadId,identity:{incarnation:x.created}});
 const trace={owner:'owner',role:'launcher-main',preserve:(fn:()=>any)=>fn(),reference:(handle:number)=>{
  const x=[...f.roots.values(),...f.helpers.values()].find(x=>x.handle===handle);if(!x)return undefined;
  return {entry:{id:x.id,pid:x.pid,incarnation:x.created,stage:x.stage,closeFailed:x.closeFailed},identity:{pid:x.pid,incarnation:x.created,exitCode:x.exitCode},complete:x.complete};},closeResult:(id:string)=>proofs.get(id)};
 const source=readFileSync(join(import.meta.dir,'fault-root-reference-export.txt'),'utf8').replace('export function','function');
 const js=new Bun.Transpiler({loader:'ts'}).transformSync(source);
 const factory=new Function('FaultRootOwner','authorizeLiveFence','validateFaultNativeEvidence','readFileSync','join','traceRows','ownershipTrace','tracked','threadJobs','globalJob','nestingRefused','reportExit',js+'\nreturn ownershipFaultRootReference;');
 const exported=factory(FaultRootOwner,authorizeLiveFence,validateFaultNativeEvidence,readFileSync,join,()=>f.rows,trace,tracked,jobs,8,false,(threadId:string,pid:number)=>{expect(threadId).toBe('native-sdk');f.closures.push(pid);const close=f.nativeClose(pid);tracked.delete(pid);proofs.set(close.id,close);});
 const owner=exported('sdk','a'.repeat(32),f.artifactDirectory,'unused-trace',f.directory),service=startFaultRootService(f.directory,owner,fn=>fn());
 try{
  const result=await measureLiveRootReferences(f.arms,{...f.deps,exchange:r=>requestRootReference(f.directory,r,fn=>fn())});
  expect(result.error).toBeUndefined();expect(result.protocolValid).toBe(true);expect(f.closures).toEqual([22,21]);
  expect(readdirSync(f.directory).filter(n=>n.endsWith('.response.json'))).toHaveLength(6);
  expect(result.arms.released.released!.live!.helper.exitCode).toBe(259);
 }finally{await service.stop();f.cleanup();}
});
test('completed admission cannot silently admit a live label, and live admission rejects completed receipts',()=>{
 const f=fixture();try{
  let oldCalls=0;const r=f.arms.held.request as RootRequest,x=f.roots.get(r.root.pid)!;
  const old=new FaultRootOwner({compiler:'sdk',compilerNonce:'a'.repeat(32),now:Date.now,current:()=>x,removed:()=>false,authorize:()=>{oldCalls++;},retire:()=>{throw Error('not authorized');}});
  expect(()=>old.handle(r)).toThrow('separate live admission');expect(oldCalls).toBe(0);
  for(const receipt of [{...context(1),phase:3,acquired:2,closed:2},{...context(1),result:0}])expect(()=>authorizeLiveFence(r,x,f.helpers.get(11),encodeLiveReceipt(receipt),f.rows,Date.now())).toThrow();
 }finally{f.cleanup();}
});
test('shared control rejects extra observer output and a failed unique root close',async()=>{
 for(const failure of ['output','close']){
  const f=fixture(),observe=f.deps.observe,exchange=f.deps.exchange;
  if(failure==='output')f.deps.observe=async(r,path,phase)=>{const result=await observe(r,path,phase);return phase==='baseline'?{...result,err:result.err+'unknown'}:result;};
  else f.deps.exchange=async r=>{const result=await exchange(r);return r.phase==='release'?{...result,close:{...result.close!,success:false,error:6}}:result;};
  try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(f.closures).toEqual(failure==='close'?[22]:[]);expect(f.events.some(e=>e==='observe:comparison')).toBe(false);expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
 }
});
test('other root references drain before baseline and no deadline may be restarted',async()=>{
 const f=fixture(),observe=f.deps.observe,closed={event:'close-result',id:'extra/21',owner:'harness',role:'harness-main',pid:21,incarnation:'201',success:true,error:0,wallMs:Date.now()};
 f.rows.push({...closed,event:'acquired'});const timer=setTimeout(()=>{closed.wallMs=Date.now();f.rows.push(closed);},15);
 f.deps.observe=async(r,path,phase)=>{expect(f.rows.includes(closed)).toBe(true);return observe(r,path,phase);};
 try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(true);expect(r.deadline).toBe(f.arms.held.request.deadline);}finally{clearTimeout(timer);f.cleanup();}
 const g=fixture(),exchange=g.deps.exchange;g.deps.exchange=async r=>exchange(r.phase==='verified'?{...r,deadline:r.deadline+1}:r);
 try{const r=await measureLiveRootReferences(g.arms,g.deps);expect(r.protocolValid).toBe(false);expect(g.closures).toEqual([]);expect(r.deadline).toBe(g.arms.held.request.deadline);}finally{g.cleanup();}
});
test('a receipt expiring during observation never gains a new budget or substitute release',async()=>{
 const f=fixture(),observe=f.deps.observe;let expired=false;
 const timeout=setTimeout(()=>{for(const [label,resolve] of f.resolve)resolve({pid:label.endsWith('-HELD')?11:12,code:125,timedOut:false,out:'',err:'live-fence phase=failed error=1460'});},30);
 f.deps.now=()=>expired?f.arms.held.request.deadline:Date.now();f.deps.observe=async(r,path,phase)=>{const o=await observe(r,path,phase);if(phase==='comparison')expired=true;return o;};
 try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(f.closures).toEqual([22]);expect(r.deadline).toBe(f.arms.held.request.deadline);expect(r.helpersJoined).toBe(true);}finally{clearTimeout(timeout);f.cleanup();}
});

test('native return can precede the independently sampled post-publication clock',async()=>{
 const f=fixture(),release=f.deps.releaseHelper;
 f.deps.releaseHelper=async r=>{const x=await release(r);return {...x,publishFinishedAt:x.publishFinishedAt+10};};
 try{const result=await measureLiveRootReferences(f.arms,f.deps);expect(result.error).toBeUndefined();expect(result.protocolValid).toBe(true);}finally{f.cleanup();}
});

test('a refused second start joins progressive preparations, first capture and post-exit observers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'boite-live-start-failure-'));let starts=0,finished=0,joined=0,released=false;
 const jobs=['HELD','RELEASED'].map(role=>{const project=join(directory,role);mkdirSync(project);return {label:'ANCHOR-FAULT-ASSIGNED-LIVE-'+role,project};});
 try{
  const record=await runLiveRootHarness(jobs,{directory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:'unused',preserve:fn=>fn(),
   start:(_job,_env,spawned)=>{
    starts++;if(starts===2)throw Error('second startup refused');spawned(11);
    setTimeout(()=>writeFileSync(join(directory,'ASSIGNED-LIVE-HELD.ready.bin'),encodeLiveReceipt(context(1))),5);
    return new Promise(resolve=>setTimeout(()=>{released=existsSync(join(directory,'ASSIGNED-LIVE-HELD.release.bin'));joined++;resolve({pid:11,code:125,timedOut:false,out:'',err:'bounded native diagnostic'});},30));
   },drainHarness:async()=>{throw Error('must not drain an incomplete pair');},observe:async()=>{throw Error('must not observe an incomplete pair');},finish:async()=>{await new Promise(r=>setTimeout(r,5));finished++;return {postHelper:[],priorCleanupPassed:false};}});
  expect(record.protocolValid).toBe(false);expect(record.error).toContain('second startup refused');expect(starts).toBe(2);expect(joined).toBe(1);expect(finished).toBe(1);expect(released).toBe(true);
  await new Promise(r=>setTimeout(r,10));expect(joined).toBe(1);expect(finished).toBe(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a failed or missing stream/window cleanup cannot validate a live comparison',async()=>{
 for(const fragment of ['stream-cleanup index=1','window-cleanup action=desktop']){
  const f=fixture();f.arms.held.capture=f.arms.held.capture.then((h:any)=>({...h,err:h.err.replace(fragment+' success=1 error=0',fragment+' success=0 error=6')}));
  try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(r.error).toContain('cleanup before READY');expect(r.arms.held.helper!.code).toBe(125);expect(r.arms.held.priorCleanupPassed).toBe(false);}finally{f.cleanup();}
 }
});

test('final native result, exact created names, cleanup order and return bytes cannot be replaced by READY',async()=>{
 for(const bad of ['result','name','order','return','old-flag']){
  const f=fixture();
  if(bad==='return'){const read=f.deps.readReturn;f.deps.readReturn=r=>encodeLiveReceipt({...parseLiveReceipt(read(r)),nonce:'e'.repeat(32)});}
  else if(bad==='old-flag')f.deps.finish=async r=>({postHelper:Object.values(r.names).map(path=>observed(path,true)),priorCleanupPassed:true});
  else f.arms.held.capture=f.arms.held.capture.then((h:any)=>bad==='result'?{...h,code:0}:bad==='name'?{...h,err:h.err.replace('map-retire named path=','map-retire named wrong=')}:{...h,err:h.err.replace('caller snapshot=after map=x unchanged=1\r\n','')+'caller snapshot=after map=x unchanged=1\r\n'});
  try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.protocolValid).toBe(false);expect(r.outcome).toBe('inconclusive');expect(r.helpersJoined).toBe(true);expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);}finally{f.cleanup();}
 }
});
test('all same-time outcomes remain explicit without a general cause claim',async()=>{
 for(const [held,released,outcome] of [[false,false,'both-retained'],[true,true,'both-absent'],[true,false,'held-absent-released-retained']] as const){
  const f=fixture(),observe=f.deps.observe;
  f.deps.observe=async(r,path,phase)=>phase==='comparison'&&path===r.names.retired?observed(path,r.label.endsWith('-HELD')?held:released):observe(r,path,phase);
  try{const r=await measureLiveRootReferences(f.arms,f.deps);expect(r.error).toBeUndefined();expect(r.protocolValid).toBe(true);expect(r.outcome).toBe(outcome);expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);}finally{f.cleanup();}
 }
});

test('owner rejects a replacement live-helper reference before authorizing root release',()=>{
 const f=fixture();try{const r=f.arms.held.request as RootRequest,held=f.owner.handle(r);f.helpers.get(11)!.id='replacement-helper-ref';expect(()=>f.owner.handle({...r,phase:'verified',reference:held.sample})).toThrow('live helper custody');expect(f.closures).toEqual([]);}finally{f.cleanup();}
});
