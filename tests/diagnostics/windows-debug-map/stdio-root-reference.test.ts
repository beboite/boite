import {test,expect} from 'bun:test';
import {encodeStdioReceipt,parseStdioReceipt,type StdioReceipt} from './stdio-root-fence.ts';
const frame=(role=2,now=1000):StdioReceipt=>({version:1,phase:1,role,result:125,helper:10+role,root:20+role,helperCreated:String(100+role),rootCreated:String(200+role),ready:now,at:now+10,deadline:now+3000,rootDeadline:now+5000,nonce:(role===1?'b':'c').repeat(32),compilerNonce:'a'.repeat(32),acquired:1,closed:1,error:0,session:2,cleanup:511,streams:[0,1,2].map(i=>({original:String(100+i),crt:String(100+i),fd:i,type:3,flushAttempted:i?1:0,flushResult:0,closeAttempted:role===2?1:0,closeResult:0,invalid:role===2?1:0,invalidError:role===2?6:0,closeAt:role===2?now+i+1:0}))});
test('stdio receipts require exact CRT mappings, distinct originals, successful output flushes and immediate owner closure proofs',()=>{
 for(const role of [1,2]){const f=frame(role);expect(parseStdioReceipt(encodeStdioReceipt(f))).toEqual(f);
  for(const [key,value] of [['original','101'],['crt','999'],['fd',3],['type',1],['flushAttempted',1],['flushResult',-1],['closeAttempted',role===2?0:1],['closeResult',-1],['invalid',role===2?0:1],['invalidError',5],['closeAt',role===2?999:1001]] as const){
   const bad=structuredClone(f);Object.assign(bad.streams[0]!,{[key]:value});expect(()=>parseStdioReceipt(encodeStdioReceipt(bad)),key).toThrow();
  }
 }
});

import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {FaultRootOwner,startFaultRootService,requestRootReference,validateFaultNativeEvidence,type RootRequest,type RootOwned} from './fault-root-reference.ts';
import {authorizeActiveFence,validateActiveProof} from './live-fence-dispatch.ts';
import {LiveRootDrainer} from './live-root-drain.ts';
import {parseLiveReceipt,encodeLiveReceipt} from './live-root-fence.ts';
import {boundStdioReceipt,stdioLabels} from './stdio-root-fence.ts';
import {measureStdioRootReferences,runStdioRootHarness} from './stdio-root-reference.ts';
const request=(f:StdioReceipt):RootRequest=>{const map=`\\Sessions\\2\\BaseNamedObjects\\boite.route.${f.helper}`;return {version:1,compiler:'sdk',compilerNonce:f.compilerNonce,nonce:f.nonce,label:stdioLabels[f.role-1]!,phase:'held',helper:{pid:f.helper,created:f.helperCreated},root:{pid:f.root,created:f.rootCreated},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline:f.deadline,reference:null};};
const observed=(path:string,absent:boolean)=>({path,code:0,timedOut:false,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${+absent} closed=1 error=0\r\n`,err:absent?'':'cleanup object=map-post-exit-observer handle=000000000000018C query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=2 pointers=32772\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n'});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'boite-stdio-pair-')),controlDirectory=join(directory,'fault-root-control');mkdirSync(controlDirectory);
 const rows:any[]=[],events:string[]=[],launcher=new Map<number,RootOwned>(),harness=new Map<number,RootOwned>(),replies=new Map<string,Buffer>(),resolvers=new Map<string,(v:any)=>void>();
 const frames=[frame(1,Date.now()-10),frame(2,Date.now()-10)];frames[1]!.ready=frames[0]!.ready;frames[1]!.deadline=frames[0]!.deadline;
 const inputs=Object.fromEntries(frames.map((f,i)=>{
  const r=request(f);writeFileSync(join(controlDirectory,r.label+'.ready.bin'),encodeStdioReceipt(f));
  for(const [role,table] of [['launcher-main',launcher],['harness-main',harness]] as const)for(const [identity,code] of [[r.root,125],[r.helper,259]] as const){
   const x:RootOwned={owner:role,id:role+'/'+identity.pid,threadId:role==='launcher-main'?'native-sdk':'lpac-ANCHOR-FAULT-'+r.label,threadJob:role==='launcher-main'?'7':String(100+i),jobKey:role==='launcher-main'?3:100+i,globalJob:'8',nestingRefused:false,role,handle:identity.pid+100,pid:identity.pid,created:identity.created,exitCode:code,complete:true,closeFailed:false,stage:'tracked'};table.set(x.pid,x);
   rows.push({event:'acquired',...x,incarnation:x.created},{event:'owned-membership',...x,threadMember:1});
  }
  return [i?'released':'held',{request:r,ready:encodeStdioReceipt(f),capturedPid:f.helper,readyObservedAt:Date.now(),capture:new Promise<any>(res=>resolvers.set(r.label,res))}];
 })) as any;
 const makeOwner=(role:string,table:Map<number,RootOwned>)=>{
  const tracked=new Map([...table].map(([pid,x])=>[pid,{handle:x.handle,threadId:x.threadId,identity:{incarnation:x.created}}])),jobs=new Map([...table.values()].map(x=>[x.threadId,{handle:Number(x.threadJob),key:x.jobKey}]));
  const proofs=new Map(),trace={owner:role,role,preserve:(f:()=>any)=>f(),reference:(handle:number)=>{const x=[...table.values()].find(x=>x.handle===handle);return x?{entry:{id:x.id,pid:x.pid,incarnation:x.created,stage:x.stage,closeFailed:x.closeFailed},identity:{pid:x.pid,incarnation:x.created,exitCode:x.exitCode},complete:x.complete}:undefined;},closeResult:(id:string)=>proofs.get(id)};
  const retire=(_thread:string,pid:number)=>{const x=table.get(pid)!;events.push((role==='launcher-main'?'close:':'drain:')+pid);const close={id:x.id,success:true,error:0,wallMs:Date.now()};table.delete(pid);tracked.delete(pid);proofs.set(close.id,close);rows.push({event:'close-result',...close,owner:role,role,pid,incarnation:x.created,stage:'tracked'});};
  const source=readFileSync(join(import.meta.dir,role==='launcher-main'?'fault-root-reference-export.txt':'live-root-drain-export.txt'),'utf8').replace('export function','function');
  const name=role==='launcher-main'?'ownershipFaultRootReference':'ownershipDrainLiveRoot';
  const factory=new Function('FaultRootOwner','LiveRootDrainer','authorizeLiveFence','validateFaultNativeEvidence','readFileSync','join','traceRows','ownershipTrace','tracked','threadJobs','globalJob','nestingRefused','reportExit',new Bun.Transpiler({loader:'ts'}).transformSync(source)+'\nreturn '+name+';');
  const build=factory(FaultRootOwner,LiveRootDrainer,authorizeActiveFence,validateFaultNativeEvidence,readFileSync,join,()=>rows,trace,tracked,jobs,8,false,retire);
  return role==='launcher-main'?build('sdk','a'.repeat(32),directory,'trace',controlDirectory):build('sdk','a'.repeat(32),controlDirectory,'trace');
 };
 const owner=makeOwner('launcher-main',launcher),drainer=makeOwner('harness-main',harness);
 let joined=0;
 const deps={now:Date.now,rows:()=>rows,exchange:async(r:RootRequest)=>owner.handle(r),drainHarness:async(r:RootRequest)=>drainer.drain(r),
  observe:async(r:RootRequest,path:string,phase:string)=>{try{await new Promise(res=>setTimeout(res,2));expect(launcher.get(r.helper.pid)!.exitCode).toBe(259);events.push('observe:'+phase);return observed(path,path!==r.names.retired||(phase==='comparison'&&r.label.endsWith('-CLOSED')));}finally{joined++;}},
  releaseHelper:async(r:RootRequest)=>{
   events.push('helper:'+r.helper.pid);const f=frames.find(f=>f.helper===r.helper.pid)!,at=Date.now(),bytes=encodeStdioReceipt({...f,phase:2,at}),returned=encodeStdioReceipt({...f,phase:3,at:Date.now(),acquired:3,closed:3});replies.set(r.label,returned);
   writeFileSync(join(controlDirectory,r.label+'.release.bin'),bytes);writeFileSync(join(controlDirectory,r.label+'.return.bin'),returned);
   const marker=`stdio-fence barrier label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} ready=${f.ready} deadline=${f.deadline}`;
   const err=[`retirement-timing phase=start mode=live nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} tid=33`,
    `anchor-overlap phase=start mode=exclusive nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} setter=40`,`anchor-overlap phase=go mode=exclusive nonce=${r.nonce} helper=${r.helper.pid}`,
    `private-map path=${r.names.map} create=0x00000000`,`map-retire named path=${r.names.retired} create=0x00000000`,`directory-twin phase=create role=unused path=${r.names.unused} status=0x00000000 end=1`,
    'anchor-cleanup setter=40 created=300 acquired=5 closed=5 files-acquired=8 files-closed=8 forced=1 exit=125 error=13','cleanup job-active=0',
    ...['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'].map(slot=>`cleanup close=${slot} closed=1 error=0`),
    ...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),...['station-restore','desktop','station'].map(action=>`window-cleanup action=${action} success=1 error=0`),
    'caller snapshot=after map=x unchanged=1',`cleanup retired-open phase=final status=0x00000000 absent=0 closed=1 error=0 path=${r.names.retired}`,
    'execution.windows.routing.cleanup.final-map: native call failed (13); no unprotected fallback',marker,''].join('\r\n');
   launcher.get(r.helper.pid)!.exitCode=125;resolvers.get(r.label)!({pid:r.helper.pid,code:125,timedOut:false,out:marker+'\r\n',err});return {bytes,publishStartedAt:at,publishFinishedAt:Date.now()};
  },readReturn:(r:RootRequest)=>replies.get(r.label)!,finish:async(r:RootRequest)=>({postHelper:Object.values(r.names).map(p=>observed(p,true)),priorCleanupPassed:false})};
 return {directory,controlDirectory,frames,inputs,deps,rows,events,launcher,harness,owner,resolvers,get joined(){return joined;},cleanup(){rmSync(directory,{recursive:true,force:true});}};
}
test('generated owners and real transport discharge both roots before the independent stdio comparison',async()=>{
 const f=fixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g());
 try{const result=await measureStdioRootReferences(f.inputs,{...f.deps,exchange:r=>requestRootReference(f.controlDirectory,r,g=>g())});
  expect(result.error).toBeUndefined();expect(result.protocolValid).toBe(true);expect(result.outcome).toBe('stdio-held-retained-closed-absent');expect(f.joined).toBe(12);
  expect(result.arms.held.final).toHaveLength(0);expect(result.arms.released.final).toHaveLength(0);expect(result.causeConfirmed).toBe(false);expect(result.productionAccepted).toBe(false);
  expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.lastIndexOf('drain:22'));expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.lastIndexOf('close:22'));
  expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.lastIndexOf('close:21'));expect(f.events.indexOf('helper:11')).toBeGreaterThan(f.events.lastIndexOf('observe:comparison'));
 }finally{await service.stop();f.cleanup();}
});
test('new labels have separate admission and cannot consume legacy live bytes or completed admission',()=>{
 const f=frame(1,Date.now()-10),r=request(f),b=encodeStdioReceipt(f),ctx=fixture();try{
  expect(()=>parseLiveReceipt(b)).toThrow();expect(()=>parseStdioReceipt(encodeLiveReceipt(f))).toThrow();
  const root=ctx.launcher.get(r.root.pid)!,helper=ctx.launcher.get(r.helper.pid)!;expect(authorizeActiveFence(r,root,helper,b,ctx.rows,Date.now()).helper.exitCode).toBe(259);
  for(const patch of [{created:'999'},{exitCode:125},{closeFailed:true},{threadJob:'999'},{complete:false},{stage:'acquired'}])expect(()=>authorizeActiveFence(r,root,{...helper,...patch},b,ctx.rows,Date.now())).toThrow();
  for(const patch of [{nonce:'e'.repeat(32)},{label:'ASSIGNED-LIVE-HELD' as const},{deadline:f.deadline+1}])expect(()=>boundStdioReceipt({...r,...patch},b,Date.now())).toThrow();
  expect(()=>boundStdioReceipt(r,b,r.deadline)).toThrow();
  const legacy=new FaultRootOwner({compiler:'sdk',compilerNonce:r.compilerNonce,now:Date.now,current:()=>root,removed:()=>false,authorize:()=>{throw Error('completed admission forbidden');},retire:()=>{throw Error('close forbidden');}});
  expect(()=>legacy.handle(r)).toThrow('separate live admission');
  const proof=authorizeActiveFence(r,root,helper,b,ctx.rows,Date.now());expect(()=>validateActiveProof({...r,label:'ASSIGNED-LIVE-HELD'},proof,Date.now())).toThrow();
 }finally{ctx.cleanup();}
});
test('stdio private receipts reject premature/late phases and malformed fixed identity/cleanup fields',()=>{
 const f=frame();for(const patch of [{version:2},{result:0},{phase:4},{helper:0},{root:f.helper},{cleanup:510},{acquired:0,closed:0},{at:f.deadline},{ready:0},{deadline:f.deadline+1},{error:6},{nonce:'x'.repeat(32)}])expect(()=>parseStdioReceipt(encodeStdioReceipt({...f,...patch}))).toThrow();
 for(const size of [232,399,401])expect(()=>parseStdioReceipt(Buffer.alloc(size))).toThrow();
 const r=request(f);expect(()=>boundStdioReceipt(r,encodeStdioReceipt({...f,phase:2}),1011)).toThrow();
});
test('both fresh serialized harness drains are necessary before any stdio baseline',async()=>{
 const f=fixture(),drain=f.deps.drainHarness,exchange=f.deps.exchange,proofs=new Map();f.deps.drainHarness=async r=>{const p=await drain(r);proofs.set(r.label,p);return p;};
 f.deps.exchange=async r=>{const p=await exchange(r);if(r.label.endsWith('-CLOSED')&&r.phase==='held')proofs.get(r.label).removed=false;return p;};
 try{const result=await measureStdioRootReferences(f.inputs,f.deps);expect(result.protocolValid).toBe(false);expect(f.joined).toBe(0);expect(f.events.filter(e=>e.startsWith('close:'))).toHaveLength(0);expect(result.helpersJoined).toBe(true);}finally{f.cleanup();}
});
test('stdio failures join all six observers before releasing either helper and do not retry closure',async()=>{
 const f=fixture(),observe=f.deps.observe,release=f.deps.releaseHelper;let settled=0;
 f.deps.observe=async(r,p,phase)=>{if(phase!=='comparison')return observe(r,p,phase);try{await new Promise(res=>setTimeout(res,8));if(p===r.names.map)throw Error('failed comparison');return observed(p,false);}finally{settled++;}};
 f.deps.releaseHelper=async r=>{expect(settled).toBe(6);return release(r);};
 try{const result=await measureStdioRootReferences(f.inputs,f.deps);expect(result.protocolValid).toBe(false);expect(result.helpersJoined).toBe(true);expect(settled).toBe(6);expect(f.events.filter(e=>e.startsWith('close:'))).toHaveLength(2);}finally{f.cleanup();}
});
test('any output after the barrier or failed pre-barrier cleanup forbids a successful stdio result',async()=>{
 for(const bad of ['out','err','cleanup']){const f=fixture();for(const [key,resolve] of f.resolvers)f.resolvers.set(key,value=>{if(bad==='cleanup')value.err=value.err.replace('stream-cleanup index=0 success=1 error=0','stream-cleanup index=0 success=0 error=6');else value[bad]+='unexpected output';resolve(value);});
  try{const result=await measureStdioRootReferences(f.inputs,f.deps);expect(result.protocolValid).toBe(false);expect(result.helpersJoined).toBe(true);expect(result.outcome).toBe('inconclusive');}finally{f.cleanup();}
 }
});
test('a synchronous second stdio launch refusal joins previously acquired capture and finish work',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'boite-stdio-launch-'));let calls=0,captured=false,finished=false;
 try{const jobs=[{label:'ANCHOR-FAULT-ASSIGNED-STDIO-HELD',project:dir},{label:'ANCHOR-FAULT-ASSIGNED-STDIO-CLOSED',project:dir}];
  const result=await runStdioRootHarness(jobs,{directory:dir,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:dir,preserve:f=>f(),start:()=>{if(++calls===2)throw Error('second launch refused');return new Promise<any>(resolve=>setTimeout(()=>{captured=true;resolve({pid:11,code:125,timedOut:false,out:'',err:''});},10));},drainHarness:async()=>{throw Error('not admitted');},observe:async()=>{throw Error('not observed');},finish:async()=>{expect(captured).toBe(true);finished=true;return {postHelper:[],priorCleanupPassed:false};}});
  expect(result.protocolValid).toBe(false);expect(captured).toBe(true);expect(finished).toBe(true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a published native failure after RETURN invalidates the stdio harness even with otherwise complete receipts',async()=>{
 for(const hasFailure of [false,true]){
 const f=fixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g()),seen=new Set<string>();
 if(hasFailure)for(const [label,resolve] of f.resolvers)f.resolvers.set(label,value=>{writeFileSync(join(f.controlDirectory,label+'.failed.bin'),encodeStdioReceipt({...f.frames.find(x=>request(x).label===label)!,phase:4,error:1460}));resolve(value);});
 const timer=setInterval(()=>{for(const arm of Object.values(f.inputs) as any[]){const r=arm.request as RootRequest;if(!seen.has(r.label)&&existsSync(join(f.controlDirectory,r.label+'.release.bin'))){seen.add(r.label);void f.deps.releaseHelper(r);}}},2);
 try{const jobs=stdioLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory}));
  const result=await runStdioRootHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>{writeFileSync(join(f.directory,'harness-fixture.jsonl'),f.rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return g();},start:(_j,env,spawned)=>{const arm=Object.values(f.inputs).find((a:any)=>a.request.label===env.BOITE_STDIO_ROOT_LABEL) as any;spawned(arm.capturedPid);return arm.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>f.deps.finish(r!)});
  expect(result.protocolValid,result.error).toBe(!hasFailure);
  const failures=(result as any).nativeFailures;expect(failures).toHaveLength(hasFailure?2:0);
  if(hasFailure){expect(result.error).toContain('native failure receipt');for(const proof of failures){expect(proof.error).toBe(1460);expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));}}
 }finally{clearInterval(timer);await service.stop();f.cleanup();}
 }
});

test('a helper captured after the fixed deadline is inconclusive even when RETURN remains valid and failed publication is unavailable',async()=>{
 const f=fixture(),deadline=f.inputs.held.request.deadline;
 f.deps.now=()=>[11,12].every(p=>f.launcher.get(p)!.exitCode===125)?deadline:Date.now();
 try{const result=await measureStdioRootReferences(f.inputs,f.deps);expect(result.protocolValid).toBe(false);expect(result.error).toContain('captured return before original deadline');expect(result.helpersJoined).toBe(true);expect(result.deadline).toBe(deadline);}finally{f.cleanup();}
});
test('a pre-READY native failure preserves its private bytes and joins both failed captures and finish callbacks',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'boite-stdio-before-ready-'));let finishes=0;
 try{const result=await runStdioRootHarness(stdioLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:directory})),{directory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:directory,preserve:f=>f(),start:(_job,env,spawned)=>{
  const role=env.BOITE_STDIO_ROOT_LABEL!.endsWith('-HELD')?1:2,f=frame(role,Date.now()-10);spawned(f.helper);writeFileSync(join(directory,env.BOITE_STDIO_ROOT_LABEL+'.failed.bin'),encodeStdioReceipt({...f,phase:4,error:13}));return Promise.resolve({pid:f.helper,code:125,timedOut:false,out:'',err:''});},drainHarness:async()=>{throw Error('not admitted');},observe:async()=>{throw Error('not observed');},finish:async()=>{finishes++;return {postHelper:[],priorCleanupPassed:false};}});
  expect(result.protocolValid).toBe(false);expect(result.error).toContain('native failure receipt');expect(finishes).toBe(2);expect((result as any).nativeFailures).toHaveLength(2);for(const proof of (result as any).nativeFailures){expect(proof.error).toBe(13);expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));}
 }finally{rmSync(directory,{recursive:true,force:true});}
});
