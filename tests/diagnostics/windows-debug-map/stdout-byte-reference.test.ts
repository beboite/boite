import {test,expect} from 'bun:test';
import {frame} from './stdio-reference-fixture.ts';
import {encodeStreamReceipt,parseStreamReceipt} from './stdio-root-fence.ts';
const byteFrame=(role=2,now=1000)=>({...frame(role,now),streams:frame(role,now).streams.map(s=>({...s,closeAttempted:0,invalid:0,invalidError:0,closeAt:0})),zero:role===1?{attempted:0,result:0,transferred:0,error:0,at:0}:{attempted:1,result:1,transferred:1,error:0,at:now+1}});
test('one-byte actual-call codec authenticates count one independently of legacy zero-byte evidence',()=>{
 for(const role of [1,2]){const f=byteFrame(role),bytes=encodeStreamReceipt(f,'stdout-byte');expect(bytes.length).toBe(424);expect(bytes.readUInt32LE(0)).toBe(0x42574631);expect(parseStreamReceipt(bytes,'stdout-byte')).toEqual(f);
  for(const foreign of ['stdio','stdout-write','stdout-zero'] as const)expect(()=>parseStreamReceipt(bytes,foreign)).toThrow();
  for(const foreign of ['stdio','stdout-write','stdout-zero'] as const)expect(()=>parseStreamReceipt(encodeStreamReceipt({...f,zero:{...f.zero,transferred:0}},foreign),'stdout-byte')).toThrow();
 }
 for(const patch of [{attempted:0},{attempted:2},{result:0},{result:2},{transferred:0},{transferred:2},{transferred:0xffffffff},{error:6},{at:999},{at:1011}]){const f=byteFrame();Object.assign(f.zero,patch);expect(()=>parseStreamReceipt(encodeStreamReceipt(f,'stdout-byte'),'stdout-byte')).toThrow();}
 for(const patch of [{attempted:1},{result:1},{transferred:1},{error:6},{at:1001}]){const f=byteFrame(1);Object.assign(f.zero,patch);expect(()=>parseStreamReceipt(encodeStreamReceipt(f,'stdout-byte'),'stdout-byte')).toThrow();}
 const z=byteFrame();z.zero.transferred=0;expect(parseStreamReceipt(encodeStreamReceipt(z,'stdout-zero'),'stdout-zero').zero!.transferred).toBe(0);
 expect(()=>encodeStreamReceipt(byteFrame(),'unknown' as any)).toThrow('explicit stream experiment');
 const bytes=encodeStreamReceipt(byteFrame(),'stdout-byte');for(const invalid of [bytes.subarray(0,400),Buffer.concat([bytes,Buffer.alloc(1)])])expect(()=>parseStreamReceipt(invalid,'stdout-byte')).toThrow();
});

import {fixture,assignedStdout,fixtureMarker} from './stdio-reference-fixture.ts';
import {byteLabels,boundByteReceipt,encodeByteReceipt,parseByteReceipt} from './stdout-byte-fence.ts';
import {measureByteReferences,runByteHarness} from './stdout-byte-reference.ts';
import {authorizeActiveFence,validateActiveProof} from './live-fence-dispatch.ts';
import {FaultRootOwner,startFaultRootService,requestRootReference,type RootRequest} from './fault-root-reference.ts';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {prepareOwnership} from './ownership-generate.ts';
import {createHash} from 'node:crypto';
const makeFixture=(absent:(r:RootRequest)=>boolean=r=>r.label===byteLabels[1])=>{
 const f=fixture({labels:byteLabels,encode:encodeByteReceipt,openOriginals:true,barrierPrefix:'byte',stdoutPrefix:assignedStdout,stdoutWrites:()=>false,decorate:f=>{f.zero=f.role===1?{attempted:0,result:0,transferred:0,error:0,at:0}:{attempted:1,result:1,transferred:1,error:0,at:f.ready+1};},comparisonAbsent:absent});
 const resolve=f.resolvers.get(byteLabels[1])!;f.resolvers.set(byteLabels[1],v=>{v.out+='!';resolve(v);});return f;
};
test('byte controller uses generated owner exports and real private transport before draining both roots and joining observers',async()=>{
 const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g());
 try{const r=await measureByteReferences(f.inputs,{...f.deps,exchange:r=>requestRootReference(f.controlDirectory,r,g=>g())});
  expect(r.protocolValid,r.error).toBe(true);expect(r.outcome).toBe('silent-retained-byte-absent');expect(f.joined).toBe(12);
  for(const [key,a] of Object.entries(r.arms)){expect(a.helper!.out).toBe(assignedStdout(a.request)+(key==='released'?'!':''));expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(parseByteReceipt(Buffer.from(a.ready.bytes,'base64')).streams.every(s=>s.closeAttempted===0)).toBe(true);expect(a.priorCleanupPassed).toBe(false);}
  expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:21'));expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:22'));
  expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:21'));expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:22'));expect(f.events.indexOf('helper:11')).toBeGreaterThan(f.events.lastIndexOf('observe:comparison'));
  expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);
  const provenance=prepareOwnership(join(f.directory,'generated'));const path=join(import.meta.dir,'stdout-byte-fence.ts');expect(provenance.hashes[path]).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
 }finally{await service.stop();f.cleanup();}
});
test('byte admission requires its own protocol role identities and bounded owner evidence',()=>{
 const f=makeFixture(),a=f.inputs.held,r=a.request as RootRequest,root=f.launcher.get(r.root.pid)!,helper=f.launcher.get(r.helper.pid)!;
 try{expect(boundByteReceipt(r,a.ready,Date.now()).role).toBe(1);const proof=authorizeActiveFence(r,root,helper,a.ready,f.rows,Date.now());expect(proof.helper.exitCode).toBe(259);
  for(const patch of [{label:'ASSIGNED-ZERO-SILENT'},{label:byteLabels[1]},{nonce:'e'.repeat(32)},{compilerNonce:'e'.repeat(32)},{deadline:r.deadline+1},{names:{...r.names,map:r.names.map+'.wrong'}},{helper:{...r.helper,created:'999'}},{root:{...r.root,created:'999'}}])expect(()=>boundByteReceipt({...r,...patch} as RootRequest,a.ready,Date.now())).toThrow();
  expect(()=>boundByteReceipt(r,a.ready,r.deadline)).toThrow();
  for(const patch of [{exitCode:125},{complete:false},{closeFailed:true},{stage:'acquired'},{threadJob:'999'}])expect(()=>authorizeActiveFence(r,root,{...helper,...patch},a.ready,f.rows,Date.now())).toThrow();
  expect(()=>validateActiveProof({...r,label:'ASSIGNED-ZERO-SILENT'},proof,Date.now())).toThrow();
  const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:r.compilerNonce,now:Date.now,current:()=>root,removed:()=>false,authorize:()=>{throw Error('completed forbidden');},retire:()=>{throw Error('raw close forbidden');}});expect(()=>owner.handle(r)).toThrow('separate live admission');
 }finally{f.cleanup();}
});
test('byte captures reject missing wrong duplicated or extra suffix bytes and changed three-generation identity',async()=>{
 for(const mutate of [
  (v:any)=>v.out=v.out.slice(0,-1),
  (v:any)=>v.out=v.out.slice(0,-1)+'?',
  (v:any)=>v.out+='!',
  (v:any)=>v.out+='\r\n',
  (v:any)=>v.out='unexpected\r\n'+v.out,
  (v:any)=>v.out=v.out.replace('generation-0 pid=22','generation-0 pid=999'),
  (v:any)=>v.out=v.out.replace(' appcontainer=1',' appcontainer=0'),
  (v:any)=>v.err+='unexpected',
 ]){const f=makeFixture();
  // Mutate the final capture, after the fixture appended the native suffix.
  f.inputs.released.capture=f.inputs.released.capture.then((v:any)=>{mutate(v);return v;});
  try{const r=await measureByteReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.outcome).toBe('inconclusive');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
 }
 const f=makeFixture();f.inputs.held.capture=f.inputs.held.capture.then((v:any)=>({...v,out:v.out+'!'}));try{const r=await measureByteReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});
test('byte actual-call metadata is immutable across READY release and native RETURN',async()=>{
 for(const phase of ['release','return'] as const){const f=makeFixture();
  if(phase==='return'){const original=f.deps.readReturn;f.deps.readReturn=r=>{const value=parseByteReceipt(original(r));if(value.role===2)value.zero.at++;return encodeByteReceipt(value);};}
  else{const original=f.deps.releaseHelper;f.deps.releaseHelper=async r=>{const result=await original(r);const value=parseByteReceipt(result.bytes);if(value.role===2)value.zero.at++;return {...result,bytes:encodeByteReceipt(value)};};}
  try{const r=await measureByteReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.helpersJoined).toBe(true);expect(r.error).toContain(phase==='return'?'exact native RETURN':'ordered private release/RETURN');}finally{f.cleanup();}
 }
});
test('byte harness uses separate environment and archives exact failed actual-call receipts',async()=>{
 for(const failed of [false,true]){const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g()),seen=new Set<string>();
  if(failed)for(const a of Object.values(f.inputs) as any[])writeFileSync(join(f.controlDirectory,a.request.label+'.failed.bin'),encodeByteReceipt({...f.frames.find(x=>x.helper===a.capturedPid)!,phase:4,error:5,...(a.request.label===byteLabels[1]?{zero:{attempted:1,result:0,transferred:0,error:5,at:f.frames[1]!.ready+1}}:{})}));
  const timer=setInterval(()=>{for(const a of Object.values(f.inputs) as any[]){const label=a.request.label;if(!seen.has(label)&&(failed||existsSync(join(f.controlDirectory,label+'.release.bin')))){seen.add(label);void f.deps.releaseHelper(a.request);}}},2);
  try{const jobs=byteLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory,marker:fixtureMarker((Object.values(f.inputs) as any[]).find(a=>a.request.label===label).request)}));
   const result=await runByteHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>{writeFileSync(join(f.directory,'harness-fixture.jsonl'),f.rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return g();},start:(_j,env,spawned)=>{expect(Object.keys(env).sort()).toEqual(['BOITE_STDOUT_BYTE_DIRECTORY','BOITE_STDOUT_BYTE_LABEL','BOITE_STDOUT_BYTE_NONCE']);const a=(Object.values(f.inputs) as any[]).find(a=>a.request.label===env.BOITE_STDOUT_BYTE_LABEL);spawned(a.capturedPid);return a.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>f.deps.finish(r!)});
   expect(result.protocolValid,result.error).toBe(!failed);expect((result as any).nativeFailures).toHaveLength(failed?2:0);
   for(const proof of (result as any).nativeFailures){expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));expect(proof.size).toBe(424);expect(proof.error).toBe(5);}
  }finally{clearInterval(timer);await service.stop();f.cleanup();}
 }
});
