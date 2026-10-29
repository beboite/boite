import {test,expect} from 'bun:test';
import {frame} from './stdio-reference-fixture.ts';
import {encodeStdioReceipt,parseStdioReceipt} from './stdio-root-fence.ts';
import {encodeLiveReceipt,parseLiveReceipt} from './live-root-fence.ts';
import {encodeStdoutReceipt,parseStdoutReceipt} from './stdout-write-fence.ts';
const openFrame=(role:number)=>{const f=frame(1);f.role=role;return f;};
test('stdout receipts select a distinct experiment and require zero closes even for WRITE',()=>{
 for(const role of [1,2]){const f=openFrame(role),bytes=encodeStdoutReceipt(f);expect(parseStdoutReceipt(bytes)).toEqual(f);
  expect(()=>parseStdioReceipt(bytes)).toThrow();expect(()=>parseLiveReceipt(bytes)).toThrow();
  expect(()=>parseStdoutReceipt(encodeStdioReceipt(f))).toThrow();expect(()=>parseStdoutReceipt(encodeLiveReceipt(f))).toThrow();
  for(const patch of [{closeAttempted:1},{closeResult:-1},{invalid:1},{invalidError:6},{closeAt:1001},{crt:'999'},{original:'101'},{flushResult:-1}]){const bad=structuredClone(f);Object.assign(bad.streams[0]!,patch);expect(()=>parseStdoutReceipt(encodeStdoutReceipt(bad))).toThrow();}
 }
});

import {fixture,request,assignedStdout,fixtureMarker,observed} from './stdio-reference-fixture.ts';
import {stdoutLabels,boundStdoutReceipt} from './stdout-write-fence.ts';
import {measureStdoutReferences,runStdoutHarness,validateAssignedStdout} from './stdout-write-reference.ts';
import {authorizeActiveFence,validateActiveProof} from './live-fence-dispatch.ts';
import {FaultRootOwner,startFaultRootService,requestRootReference,type RootRequest} from './fault-root-reference.ts';
import {writeFileSync,readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const makeFixture=(absent:(r:RootRequest)=>boolean=r=>r.label===stdoutLabels[1])=>fixture({labels:stdoutLabels,encode:encodeStdoutReceipt,openOriginals:true,barrierPrefix:'stdout',stdoutPrefix:assignedStdout,stdoutWrites:r=>r.label===stdoutLabels[1],comparisonAbsent:absent});
test('generated exports and real root transport preserve both original stream sets and release both exact roots before stdout comparison',async()=>{
 const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g());
 try{const r=await measureStdoutReferences(f.inputs,{...f.deps,exchange:r=>requestRootReference(f.controlDirectory,r,g=>g())});
  expect(r.error).toBeUndefined();expect(r.protocolValid).toBe(true);expect(r.outcome).toBe('silent-retained-write-absent');expect(f.joined).toBe(12);
  for(const a of Object.values(r.arms)){expect(a.final).toHaveLength(0);expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(parseStdoutReceipt(Buffer.from(a.ready.bytes,'base64')).streams.every(s=>s.closeAttempted===0)).toBe(true);expect(a.priorCleanupPassed).toBe(false);}
  expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:21'));expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:22'));
  expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:21'));expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:22'));expect(f.events.indexOf('helper:11')).toBeGreaterThan(f.events.lastIndexOf('observe:comparison'));
  expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);
 }finally{await service.stop();f.cleanup();}
});
test('stdout neutral outcomes never use stdio closure vocabulary',async()=>{
 for(const [silent,write,outcome] of [[false,false,'both-retained'],[true,true,'both-absent'],[true,false,'silent-absent-write-retained']] as const){const f=makeFixture(r=>r.label===stdoutLabels[0]?silent:write);
  try{const result=await measureStdoutReferences(f.inputs,f.deps);expect(result.protocolValid,result.error).toBe(true);expect(result.outcome).toBe(outcome);}finally{f.cleanup();}
 }
});
test('stdout admission binds its own role/magic/identity/deadline and cannot fall back to completed admission',()=>{
 const f=makeFixture(),a=f.inputs.held,r=a.request as RootRequest,root=f.launcher.get(r.root.pid)!,helper=f.launcher.get(r.helper.pid)!;
 try{expect(boundStdoutReceipt(r,a.ready,Date.now()).role).toBe(1);const proof=authorizeActiveFence(r,root,helper,a.ready,f.rows,Date.now());expect(proof.helper.exitCode).toBe(259);
  for(const patch of [{label:'ASSIGNED-STDIO-HELD'},{label:stdoutLabels[1]},{nonce:'e'.repeat(32)},{deadline:r.deadline+1},{helper:{...r.helper,created:'999'}},{root:{...r.root,created:'999'}}])expect(()=>boundStdoutReceipt({...r,...patch} as RootRequest,a.ready,Date.now())).toThrow();
  expect(()=>boundStdoutReceipt(r,a.ready,r.deadline)).toThrow();
  for(const patch of [{exitCode:125},{complete:false},{closeFailed:true},{stage:'acquired'},{threadJob:'999'}])expect(()=>authorizeActiveFence(r,root,{...helper,...patch},a.ready,f.rows,Date.now())).toThrow();
  expect(()=>validateActiveProof({...r,label:'ASSIGNED-LIVE-HELD'},proof,Date.now())).toThrow();
  const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:r.compilerNonce,now:Date.now,current:()=>root,removed:()=>false,authorize:()=>{throw Error('completed forbidden');},retire:()=>{throw Error('raw close forbidden');}});
  expect(()=>owner.handle(r)).toThrow('separate live admission');
 }finally{f.cleanup();}
});
test('stdout captures reject arbitrary prefixes, changed job/root/child chains, missing WRITE marker and any post-barrier bytes',async()=>{
 for(const mutate of [
  (v:any)=>v.out='unexpected\r\n'+v.out,
  (v:any)=>v.out=v.out.replace(' appcontainer=1',' appcontainer=0'),
  (v:any)=>v.out=v.out.replace('generation-0 pid=21','generation-0 pid=999'),
  (v:any)=>v.out=v.out.replace('child-created=1 pid=','child-created=1 pid=9'),
  (v:any)=>v.out=v.out.replace(/stdout-fence[^\n]*\n/g,''),
  (v:any)=>v.out+='unexpected',
  (v:any)=>v.err+='unexpected',
  (v:any)=>v.err=v.err.replace('window-cleanup action=desktop success=1 error=0','window-cleanup action=desktop success=0 error=6'),
 ]){const f=makeFixture();for(const [label,resolve] of f.resolvers)f.resolvers.set(label,value=>{mutate(value);resolve(value);});
  try{const r=await measureStdoutReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.outcome).toBe('inconclusive');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
 }
});
test('the shared empty stdout fixture remains empty and SILENT does not drop a real child prefix',async()=>{
 const old=fixture();try{const r=await (await import('./stdio-root-reference.ts')).measureStdioRootReferences(old.inputs,old.deps);const a=r.arms.held;const marker=a.helper!.out.trim();expect(a.helper!.out).toBe(marker+'\r\n');expect(a.stdoutPrefix).toBeUndefined();}finally{old.cleanup();}
 const f=makeFixture();try{const r=await measureStdoutReferences(f.inputs,f.deps);const a=r.arms.held;expect(a.helper!.out).toBe(a.stdoutPrefix!);expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(a.helper!.out).not.toContain('stdout-fence');}finally{f.cleanup();}
});
test('stdout harness archives failed receipts before READY and after a valid RETURN and rejects a capture after its fixed deadline',async()=>{
 for(const failureAt of ['none','before','after'] as const){const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g()),seen=new Set<string>();
  if(failureAt==='before')for(const a of Object.values(f.inputs) as any[])writeFileSync(join(f.controlDirectory,a.request.label+'.failed.bin'),encodeStdoutReceipt({...f.frames.find(x=>x.helper===a.capturedPid)!,phase:4,error:13}));
  if(failureAt==='after')for(const [label,resolve] of f.resolvers)f.resolvers.set(label,value=>{writeFileSync(join(f.controlDirectory,label+'.failed.bin'),encodeStdoutReceipt({...f.frames.find(x=>x.helper===value.pid)!,phase:4,error:1460}));resolve(value);});
  const timer=setInterval(()=>{for(const a of Object.values(f.inputs) as any[]){const label=a.request.label;if(!seen.has(label)&&((failureAt==='before')||existsSync(join(f.controlDirectory,label+'.release.bin')))){seen.add(label);void f.deps.releaseHelper(a.request);}}},2);
  try{const jobs=stdoutLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory,marker:fixtureMarker((Object.values(f.inputs) as any[]).find(a=>a.request.label===label).request)}));
   const result=await runStdoutHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>{writeFileSync(join(f.directory,'harness-fixture.jsonl'),f.rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return g();},start:(_j,env,spawned)=>{expect(Object.keys(env).sort()).toEqual(['BOITE_STDOUT_WRITE_DIRECTORY','BOITE_STDOUT_WRITE_LABEL','BOITE_STDOUT_WRITE_NONCE']);const a=(Object.values(f.inputs) as any[]).find(a=>a.request.label===env.BOITE_STDOUT_WRITE_LABEL);spawned(a.capturedPid);return a.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>f.deps.finish(r!)});
   expect(result.protocolValid,result.error).toBe(failureAt==='none');expect((result as any).nativeFailures).toHaveLength(failureAt==='none'?0:2);
   for(const proof of (result as any).nativeFailures){expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));expect(proof.error).toBe(failureAt==='before'?13:1460);}
  }finally{clearInterval(timer);await service.stop();f.cleanup();}
 }
 const f=makeFixture();f.deps.now=()=>[11,12].every(p=>f.launcher.get(p)!.exitCode===125)?f.inputs.held.request.deadline:Date.now();
 try{const r=await measureStdoutReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.error).toContain('captured return before original deadline');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});
