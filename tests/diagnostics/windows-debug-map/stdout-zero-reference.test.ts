import {test,expect} from 'bun:test';
import {frame} from './stdio-reference-fixture.ts';
import {encodeZeroReceipt,parseZeroReceipt,type ZeroReceipt} from './stdout-zero-fence.ts';
import {encodeStdioReceipt,parseStdioReceipt} from './stdio-root-fence.ts';
import {encodeStdoutReceipt,parseStdoutReceipt} from './stdout-write-fence.ts';
import {parseLiveReceipt} from './live-root-fence.ts';
const zeroFrame=(role=2,now=1000):ZeroReceipt=>({...frame(role,now),streams:frame(role,now).streams.map(s=>({...s,closeAttempted:0,invalid:0,invalidError:0,closeAt:0})),zero:role===1?{attempted:0,result:0,transferred:0,error:0,at:0}:{attempted:1,result:1,transferred:0,error:0,at:now+1}});
test('zero-byte receipts require actual zero-byte write evidence and reject every foreign stream protocol',()=>{
 for(const role of [1,2]){const f=zeroFrame(role),b=encodeZeroReceipt(f);expect(b.length).toBe(424);expect(b.readUInt32LE(0)).toBe(0x5a574631);expect(b.readUInt32LE(8)).toBe(424);expect(parseZeroReceipt(b)).toEqual(f);
  for(const parser of [parseStdioReceipt,parseStdoutReceipt,parseLiveReceipt])expect(()=>parser(b)).toThrow();
  for(const bytes of [encodeStdioReceipt(f),encodeStdoutReceipt(f),b.subarray(0,400),Buffer.concat([b,Buffer.alloc(1)])])expect(()=>parseZeroReceipt(bytes)).toThrow();
 }
 for(const patch of [{attempted:0},{attempted:2},{result:0},{result:2},{transferred:1},{transferred:0xffffffff},{error:6},{at:999},{at:1011}]){const f=zeroFrame();Object.assign(f.zero,patch);expect(()=>parseZeroReceipt(encodeZeroReceipt(f))).toThrow();}
 for(const patch of [{attempted:1},{result:1},{transferred:1},{error:6},{at:1001}]){const f=zeroFrame(1);Object.assign(f.zero,patch);expect(()=>parseZeroReceipt(encodeZeroReceipt(f))).toThrow();}
 const unsafe=encodeZeroReceipt(zeroFrame());unsafe.writeBigUInt64LE(0xffffffffffffffffn,416);expect(()=>parseZeroReceipt(unsafe)).toThrow('safe native integer');
 for(const patch of [{crt:'999'},{closeAttempted:1},{invalid:1},{closeAt:1001},{flushResult:-1}]){const f=zeroFrame();Object.assign(f.streams[1]!,patch);expect(()=>parseZeroReceipt(encodeZeroReceipt(f))).toThrow();}
});

import {fixture,request,assignedStdout,fixtureMarker,observed} from './stdio-reference-fixture.ts';
import {zeroLabels,boundZeroReceipt} from './stdout-zero-fence.ts';
import {measureZeroReferences,runZeroHarness,validateZeroCapture} from './stdout-zero-reference.ts';
import {authorizeActiveFence,validateActiveProof} from './live-fence-dispatch.ts';
import {FaultRootOwner,startFaultRootService,requestRootReference,type RootRequest} from './fault-root-reference.ts';
import {writeFileSync,readFileSync,existsSync,mkdtempSync,rmSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
const makeFixture=(absent:(r:RootRequest)=>boolean=r=>r.label===zeroLabels[1])=>fixture({labels:zeroLabels,encode:encodeZeroReceipt,openOriginals:true,barrierPrefix:'zero',stdoutPrefix:assignedStdout,stdoutWrites:()=>false,decorate:f=>{f.zero=f.role===1?{attempted:0,result:0,transferred:0,error:0,at:0}:{attempted:1,result:1,transferred:0,error:0,at:f.ready+1};},comparisonAbsent:absent});
test('generated exports and real root transport preserve both original stream sets and release both exact roots before zero-byte comparison',async()=>{
 const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g());
 try{const r=await measureZeroReferences(f.inputs,{...f.deps,exchange:r=>requestRootReference(f.controlDirectory,r,g=>g())});
  expect(r.error).toBeUndefined();expect(r.protocolValid).toBe(true);expect(r.outcome).toBe('silent-retained-zero-absent');expect(f.joined).toBe(12);
  for(const a of Object.values(r.arms)){expect(a.final).toHaveLength(0);expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(parseZeroReceipt(Buffer.from(a.ready.bytes,'base64')).streams.every(s=>s.closeAttempted===0)).toBe(true);expect(a.priorCleanupPassed).toBe(false);}
  expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:21'));expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:22'));
  expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:21'));expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:22'));expect(f.events.indexOf('helper:11')).toBeGreaterThan(f.events.lastIndexOf('observe:comparison'));
  expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);
 }finally{await service.stop();f.cleanup();}
});
test('zero-byte stdout neutral outcomes never use stdio closure vocabulary',async()=>{
 for(const [silent,write,outcome] of [[false,false,'both-retained'],[true,true,'both-absent'],[true,false,'silent-absent-zero-retained']] as const){const f=makeFixture(r=>r.label===zeroLabels[0]?silent:write);
  try{const result=await measureZeroReferences(f.inputs,f.deps);expect(result.protocolValid,result.error).toBe(true);expect(result.outcome).toBe(outcome);expect(result.causeConfirmed).toBe(false);expect(result.productionAccepted).toBe(false);}finally{f.cleanup();}
 }
});
test('zero-byte stdout admission binds its own role/magic/identity/deadline and cannot fall back to completed admission',()=>{
 const f=makeFixture(),a=f.inputs.held,r=a.request as RootRequest,root=f.launcher.get(r.root.pid)!,helper=f.launcher.get(r.helper.pid)!;
 try{expect(boundZeroReceipt(r,a.ready,Date.now()).role).toBe(1);const proof=authorizeActiveFence(r,root,helper,a.ready,f.rows,Date.now());expect(proof.helper.exitCode).toBe(259);
  for(const patch of [{label:'ASSIGNED-STDIO-HELD'},{label:zeroLabels[1]},{nonce:'e'.repeat(32)},{deadline:r.deadline+1},{helper:{...r.helper,created:'999'}},{root:{...r.root,created:'999'}}])expect(()=>boundZeroReceipt({...r,...patch} as RootRequest,a.ready,Date.now())).toThrow();
  expect(()=>boundZeroReceipt(r,a.ready,r.deadline)).toThrow();
  for(const patch of [{exitCode:125},{complete:false},{closeFailed:true},{stage:'acquired'},{threadJob:'999'}])expect(()=>authorizeActiveFence(r,root,{...helper,...patch},a.ready,f.rows,Date.now())).toThrow();
  expect(()=>validateActiveProof({...r,label:'ASSIGNED-LIVE-HELD'},proof,Date.now())).toThrow();
  const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:r.compilerNonce,now:Date.now,current:()=>root,removed:()=>false,authorize:()=>{throw Error('completed forbidden');},retire:()=>{throw Error('raw close forbidden');}});
  expect(()=>owner.handle(r)).toThrow('separate live admission');
 }finally{f.cleanup();}
});
test('zero-byte stdout captures reject arbitrary prefixes, changed job/root/child chains, any helper stdout marker and any post-barrier bytes',async()=>{
 for(const mutate of [
  (v:any)=>v.out='unexpected\r\n'+v.out,
  (v:any)=>v.out=v.out.replace(' appcontainer=1',' appcontainer=0'),
  (v:any)=>v.out=v.out.replace('generation-0 pid=21','generation-0 pid=999'),
  (v:any)=>v.out=v.out.replace('child-created=1 pid=','child-created=1 pid=9'),
  (v:any)=>v.out+='zero-fence forged\r\n',
  (v:any)=>v.out+='unexpected',
  (v:any)=>v.err+='unexpected',
  (v:any)=>v.err=v.err.replace('window-cleanup action=desktop success=1 error=0','window-cleanup action=desktop success=0 error=6'),
 ]){const f=makeFixture();for(const [label,resolve] of f.resolvers)f.resolvers.set(label,value=>{mutate(value);resolve(value);});
  try{const r=await measureZeroReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.outcome).toBe('inconclusive');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
 }
});
test('the shared empty stdout fixture remains empty and SILENT does not drop a real child prefix',async()=>{
 const old=fixture();try{const r=await (await import('./stdio-root-reference.ts')).measureStdioRootReferences(old.inputs,old.deps);const a=r.arms.held;const marker=a.helper!.out.trim();expect(a.helper!.out).toBe(marker+'\r\n');expect(a.stdoutPrefix).toBeUndefined();}finally{old.cleanup();}
 const f=makeFixture();try{const r=await measureZeroReferences(f.inputs,f.deps);const a=r.arms.held;expect(a.helper!.out).toBe(a.stdoutPrefix!);expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(a.helper!.out).not.toContain('zero-fence');}finally{f.cleanup();}
});
test('zero-byte stdout harness archives failed receipts before READY and after a valid RETURN and rejects a capture after its fixed deadline',async()=>{
 for(const failureAt of ['none','before','after'] as const){const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g()),seen=new Set<string>();
  if(failureAt==='before')for(const a of Object.values(f.inputs) as any[])writeFileSync(join(f.controlDirectory,a.request.label+'.failed.bin'),encodeZeroReceipt({...f.frames.find(x=>x.helper===a.capturedPid)!,phase:4,error:a.request.label===zeroLabels[1]?5:13,...(a.request.label===zeroLabels[1]?{zero:{attempted:1,result:0,transferred:0,error:5,at:f.frames[1]!.ready+1}}:{})}));
  if(failureAt==='after')for(const [label,resolve] of f.resolvers)f.resolvers.set(label,value=>{writeFileSync(join(f.controlDirectory,label+'.failed.bin'),encodeZeroReceipt({...f.frames.find(x=>x.helper===value.pid)!,phase:4,error:1460}));resolve(value);});
  const timer=setInterval(()=>{for(const a of Object.values(f.inputs) as any[]){const label=a.request.label;if(!seen.has(label)&&((failureAt==='before')||existsSync(join(f.controlDirectory,label+'.release.bin')))){seen.add(label);void f.deps.releaseHelper(a.request);}}},2);
  try{const jobs=zeroLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory,marker:fixtureMarker((Object.values(f.inputs) as any[]).find(a=>a.request.label===label).request)}));
   const result=await runZeroHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>{writeFileSync(join(f.directory,'harness-fixture.jsonl'),f.rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return g();},start:(_j,env,spawned)=>{expect(Object.keys(env).sort()).toEqual(['BOITE_STDOUT_ZERO_DIRECTORY','BOITE_STDOUT_ZERO_LABEL','BOITE_STDOUT_ZERO_NONCE']);const a=(Object.values(f.inputs) as any[]).find(a=>a.request.label===env.BOITE_STDOUT_ZERO_LABEL);spawned(a.capturedPid);return a.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>f.deps.finish(r!)});
   expect(result.protocolValid,result.error).toBe(failureAt==='none');expect((result as any).nativeFailures).toHaveLength(failureAt==='none'?0:2);
   for(const proof of (result as any).nativeFailures){expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));expect(proof.error).toBe(failureAt==='before'?(proof.label===zeroLabels[1]?5:13):1460);if(failureAt==='before'&&proof.label===zeroLabels[1]){const raw=Buffer.from(proof.bytes,'base64');expect(raw.length).toBe(424);expect(raw.readUInt32LE(400)).toBe(1);expect(raw.readUInt32LE(404)).toBe(0);expect(raw.readUInt32LE(412)).toBe(5);}}
  }finally{clearInterval(timer);await service.stop();f.cleanup();}
 }
 const f=makeFixture();f.deps.now=()=>[11,12].every(p=>f.launcher.get(p)!.exitCode===125)?f.inputs.held.request.deadline:Date.now();
 try{const r=await measureZeroReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.error).toContain('captured return before original deadline');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});

test('zero-byte write metadata is immutable across the native private RETURN',async()=>{
 const f=makeFixture(),original=f.deps.readReturn;
 f.deps.readReturn=r=>{const value=parseZeroReceipt(original(r));if(value.role===2)value.zero.at++;return encodeZeroReceipt(value);};
 try{const r=await measureZeroReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.error).toContain('exact native RETURN');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});
test('zero-byte harness joins its first capture and final observer when the second native launch throws synchronously',async()=>{
 const f=makeFixture();let starts=0,finished=0;const timer=setInterval(()=>{const a=f.inputs.held;if(existsSync(join(f.controlDirectory,a.request.label+'.release.bin'))&&f.launcher.get(a.request.helper.pid)!.exitCode===259)void f.deps.releaseHelper(a.request);},2);
 try{const jobs=zeroLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory,marker:fixtureMarker((Object.values(f.inputs) as any[]).find(a=>a.request.label===label).request)}));
  const result=await runZeroHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>g(),start:(_j,_e,spawned)=>{if(++starts===2)throw Error('second zero launch refused');spawned(f.inputs.held.capturedPid);return f.inputs.held.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>{finished++;return f.deps.finish(r!);}});
  expect(result.protocolValid).toBe(false);expect(result.error).toContain('second zero launch refused');expect(finished).toBe(1);expect(f.events.filter(x=>x.startsWith('helper:'))).toEqual(['helper:11']);expect(f.events.some(x=>x.startsWith('drain:'))).toBe(false);
 }finally{clearInterval(timer);f.cleanup();}
});
