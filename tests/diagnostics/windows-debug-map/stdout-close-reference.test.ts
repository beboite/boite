import {test,expect} from 'bun:test';
import {frame} from './stdio-reference-fixture.ts';
import {encodeStreamReceipt,parseStreamReceipt} from './stdio-root-fence.ts';
const closeFrame=(role=2,now=1000)=>{const f=frame(role,now);for(const [i,s] of f.streams.entries())if(i!==1)Object.assign(s,{closeAttempted:0,invalid:0,invalidError:0,closeAt:0});return f;};
test('stdout closure codec authenticates only fd1 closure with its own 400-byte protocol',()=>{
 for(const role of [1,2]){const f=closeFrame(role),bytes=encodeStreamReceipt(f,'stdout-close');expect(bytes.length).toBe(400);expect(bytes.readUInt32LE(0)).toBe(0x53434631);expect(parseStreamReceipt(bytes,'stdout-close')).toEqual(f);
  for(const foreign of ['stdio','stdout-write','stdout-zero','stdout-byte'] as const){expect(()=>parseStreamReceipt(bytes,foreign)).toThrow();expect(()=>parseStreamReceipt(encodeStreamReceipt({...f,zero:{attempted:0,result:0,transferred:0,error:0,at:0}},foreign),'stdout-close')).toThrow();}
 }
 for(const index of [0,1,2])for(const patch of [{closeAttempted:0},{closeAttempted:1},{closeAttempted:2},{closeResult:1},{invalid:0},{invalid:1},{invalidError:0},{invalidError:6},{closeAt:0},{closeAt:999},{closeAt:1011},{fd:0},{crt:'999'},{flushAttempted:0}]){
  const f=closeFrame(),stream=f.streams[index]!;if(Object.entries(patch).every(([k,v])=>(stream as any)[k]===v))continue;Object.assign(stream,patch);expect(()=>parseStreamReceipt(encodeStreamReceipt(f,'stdout-close'),'stdout-close')).toThrow();
 }
 const held=closeFrame(1);Object.assign(held.streams[1]!,{closeAttempted:1,invalid:1,invalidError:6,closeAt:1001});expect(()=>parseStreamReceipt(encodeStreamReceipt(held,'stdout-close'),'stdout-close')).toThrow();
 const extra={...closeFrame(),zero:{attempted:0,result:0,transferred:0,error:0,at:0}};expect(()=>encodeStreamReceipt(extra,'stdout-close')).toThrow('no write payload');
 const bytes=encodeStreamReceipt(closeFrame(),'stdout-close');for(const invalid of [bytes.subarray(0,399),Buffer.concat([bytes,Buffer.alloc(24)])])expect(()=>parseStreamReceipt(invalid,'stdout-close')).toThrow();
});

import {fixture,assignedStdout,fixtureMarker} from './stdio-reference-fixture.ts';
import {closeLabels,boundCloseReceipt,encodeCloseReceipt,parseCloseReceipt} from './stdout-close-fence.ts';
import {measureCloseReferences,runCloseHarness} from './stdout-close-reference.ts';
import {authorizeActiveFence,validateActiveProof} from './live-fence-dispatch.ts';
import {FaultRootOwner,startFaultRootService,requestRootReference,type RootRequest} from './fault-root-reference.ts';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';import {join} from 'node:path';
import {prepareOwnership} from './ownership-generate.ts';
import {createHash} from 'node:crypto';
const makeFixture=(absent:(r:RootRequest)=>boolean=r=>r.label===closeLabels[1])=>{
 const f=fixture({labels:closeLabels,encode:encodeCloseReceipt,barrierPrefix:'close',stdoutPrefix:assignedStdout,stdoutWrites:()=>false,decorate:f=>{for(const [i,s] of f.streams.entries())if(i!==1)Object.assign(s,{closeAttempted:0,invalid:0,invalidError:0,closeAt:0});},comparisonAbsent:absent});
 return f;
};
test('close controller uses generated owner exports and real private transport before draining both roots and joining observers',async()=>{
 const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g());
 try{const r=await measureCloseReferences(f.inputs,{...f.deps,exchange:r=>requestRootReference(f.controlDirectory,r,g=>g())});
  expect(r.protocolValid,r.error).toBe(true);expect(r.outcome).toBe('stdio-held-retained-closed-absent');expect(f.joined).toBe(12);
  for(const [key,a] of Object.entries(r.arms)){expect(a.helper!.out).toBe(assignedStdout(a.request));expect(a.stdoutPrefix).toBe(assignedStdout(a.request));expect(parseCloseReceipt(Buffer.from(a.ready.bytes,'base64')).streams.every((s,i)=>s.closeAttempted===(key==='released'&&i===1?1:0))).toBe(true);expect(a.priorCleanupPassed).toBe(false);}
  expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:21'));expect(f.events.indexOf('observe:baseline')).toBeGreaterThan(f.events.indexOf('drain:22'));
  expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:21'));expect(f.events.indexOf('observe:comparison')).toBeGreaterThan(f.events.indexOf('close:22'));expect(f.events.indexOf('helper:11')).toBeGreaterThan(f.events.lastIndexOf('observe:comparison'));
  expect(r.causeConfirmed).toBe(false);expect(r.productionAccepted).toBe(false);
  const provenance=prepareOwnership(join(f.directory,'generated'));const path=join(import.meta.dir,'stdout-close-fence.ts');expect(provenance.hashes[path]).toBe(createHash('sha256').update(readFileSync(path)).digest('hex'));
 }finally{await service.stop();f.cleanup();}
});
test('close admission requires its own protocol role identities and bounded owner evidence',()=>{
 const f=makeFixture(),a=f.inputs.held,r=a.request as RootRequest,root=f.launcher.get(r.root.pid)!,helper=f.launcher.get(r.helper.pid)!;
 try{expect(boundCloseReceipt(r,a.ready,Date.now()).role).toBe(1);const proof=authorizeActiveFence(r,root,helper,a.ready,f.rows,Date.now());expect(proof.helper.exitCode).toBe(259);
  for(const patch of [{label:'ASSIGNED-ZERO-SILENT'},{label:closeLabels[1]},{nonce:'e'.repeat(32)},{compilerNonce:'e'.repeat(32)},{deadline:r.deadline+1},{names:{...r.names,map:r.names.map+'.wrong'}},{helper:{...r.helper,created:'999'}},{root:{...r.root,created:'999'}}])expect(()=>boundCloseReceipt({...r,...patch} as RootRequest,a.ready,Date.now())).toThrow();
  expect(()=>boundCloseReceipt(r,a.ready,r.deadline)).toThrow();
  for(const patch of [{exitCode:125},{complete:false},{closeFailed:true},{stage:'acquired'},{threadJob:'999'}])expect(()=>authorizeActiveFence(r,root,{...helper,...patch},a.ready,f.rows,Date.now())).toThrow();
  expect(()=>validateActiveProof({...r,label:'ASSIGNED-ZERO-SILENT'},proof,Date.now())).toThrow();
  const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:r.compilerNonce,now:Date.now,current:()=>root,removed:()=>false,authorize:()=>{throw Error('completed forbidden');},retire:()=>{throw Error('raw close forbidden');}});expect(()=>owner.handle(r)).toThrow('separate live admission');
 }finally{f.cleanup();}
});
test('close captures reject missing bytes helper markers or extra output and changed three-generation identity',async()=>{
 for(const mutate of [
  (v:any)=>v.out=v.out.slice(0,-1),
  (v:any)=>v.out+='close-fence barrier\r\n',
  (v:any)=>v.out+='!',
  (v:any)=>v.out+='\r\n',
  (v:any)=>v.out='unexpected\r\n'+v.out,
  (v:any)=>v.out=v.out.replace('generation-0 pid=22','generation-0 pid=999'),
  (v:any)=>v.out=v.out.replace(' appcontainer=1',' appcontainer=0'),
  (v:any)=>v.err+='unexpected',
 ]){const f=makeFixture();
  // Neither arm may add anything to the original three-generation transcript.
  f.inputs.released.capture=f.inputs.released.capture.then((v:any)=>{mutate(v);return v;});
  try{const r=await measureCloseReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.outcome).toBe('inconclusive');expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
 }
 const f=makeFixture();f.inputs.held.capture=f.inputs.held.capture.then((v:any)=>({...v,out:v.out+'!'}));try{const r=await measureCloseReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.helpersJoined).toBe(true);}finally{f.cleanup();}
});
test('close stdout closure metadata is immutable across READY release and native RETURN',async()=>{
 for(const phase of ['release','return'] as const)for(const change of ['close-time','original-mapping'] as const){const f=makeFixture();
  const mutate=(value:ReturnType<typeof parseCloseReceipt>)=>{if(value.role===2){const stream=value.streams[1]!;if(change==='close-time')stream.closeAt++;else stream.original=stream.crt='999';}};
  if(phase==='return'){const original=f.deps.readReturn;f.deps.readReturn=r=>{const value=parseCloseReceipt(original(r));mutate(value);return encodeCloseReceipt(value);};}
  else{const original=f.deps.releaseHelper;f.deps.releaseHelper=async r=>{const result=await original(r);const value=parseCloseReceipt(result.bytes);mutate(value);return {...result,bytes:encodeCloseReceipt(value)};};}
  try{const r=await measureCloseReferences(f.inputs,f.deps);expect(r.protocolValid).toBe(false);expect(r.helpersJoined).toBe(true);expect(r.error).toContain(phase==='return'?'exact native RETURN':'ordered private release/RETURN');}finally{f.cleanup();}
 }
});
test('close harness uses separate environment and archives exact failed closure receipts',async()=>{
 for(const failed of [false,true]){const f=makeFixture(),service=startFaultRootService(f.controlDirectory,f.owner,g=>g()),seen=new Set<string>();
  if(failed)for(const a of Object.values(f.inputs) as any[])writeFileSync(join(f.controlDirectory,a.request.label+'.failed.bin'),encodeCloseReceipt({...f.frames.find(x=>x.helper===a.capturedPid)!,phase:4,error:5}));
  const timer=setInterval(()=>{for(const a of Object.values(f.inputs) as any[]){const label=a.request.label;if(!seen.has(label)&&(failed||existsSync(join(f.controlDirectory,label+'.release.bin')))){seen.add(label);void f.deps.releaseHelper(a.request);}}},2);
  try{const jobs=closeLabels.map(label=>({label:'ANCHOR-FAULT-'+label,project:f.directory,marker:fixtureMarker((Object.values(f.inputs) as any[]).find(a=>a.request.label===label).request)}));
   const result=await runCloseHarness(jobs,{directory:f.controlDirectory,compiler:'sdk',compilerNonce:'a'.repeat(32),trace:f.directory,preserve:g=>{writeFileSync(join(f.directory,'harness-fixture.jsonl'),f.rows.map(x=>JSON.stringify(x)).join('\n')+'\n');return g();},start:(_j,env,spawned)=>{expect(Object.keys(env).sort()).toEqual(['BOITE_STDOUT_CLOSE_DIRECTORY','BOITE_STDOUT_CLOSE_LABEL','BOITE_STDOUT_CLOSE_NONCE']);const a=(Object.values(f.inputs) as any[]).find(a=>a.request.label===env.BOITE_STDOUT_CLOSE_LABEL);spawned(a.capturedPid);return a.capture;},drainHarness:f.deps.drainHarness,observe:f.deps.observe,finish:async(_j,r)=>f.deps.finish(r!)});
   expect(result.protocolValid,result.error).toBe(!failed);expect((result as any).nativeFailures).toHaveLength(failed?2:0);
   for(const proof of (result as any).nativeFailures){expect(Buffer.from(proof.bytes,'base64')).toEqual(readFileSync(proof.file));expect(proof.size).toBe(400);expect(proof.error).toBe(5);}
  }finally{clearInterval(timer);await service.stop();f.cleanup();}
 }
});

import {generate,sourcePath} from './generate.ts';
test('generated stdout close selector binds the isolated stream protocol without changing deadlines or allowing public runner options',()=>{
 const generated=generate(readFileSync(sourcePath,'utf8')),header=readFileSync(join(import.meta.dir,'stdio-root-fence.h'),'utf8'),routing=readFileSync(join(import.meta.dir,'routing.test.ts'),'utf8'),runner=readFileSync(join(import.meta.dir,'run.ts'),'utf8');
 expect(generated).toContain('close_root_mode = !wcscmp(args[1], L"anchor-close-run");');
 expect(generated).toContain('close_root_mode ? 4 : byte_root_mode ? 3 :');
 expect(generated).toContain('byte_root_mode || close_root_mode || !wcscmp(args[1], L"anchor-exclusive-run")');
 for(const field of ['LABEL','DIRECTORY','NONCE'])expect(header).toContain('experiment==4?L"BOITE_STDOUT_CLOSE_'+field+'"');
 expect(header).toContain('experiment==4?0x53434631');expect(header).toContain('bytes=(experiment==2||experiment==3)?sizeof(frame):sizeof(*f)');
 expect(header).toContain('f->base.ready+3000');expect(runner).toContain(': 170000');expect(routing).toContain('150000');
 expect(runner).toContain("mode !== '--compile-only'");expect(runner).not.toContain("mode !== '--stdout-close'");
 const scheduled=[...routing.matchAll(/key:'((?:stdio|stdout|zero|byte|close)RootReference)'/g)].map(m=>m[1]);
 expect(scheduled).toEqual(['stdioRootReference','stdoutRootReference','zeroRootReference','byteRootReference','closeRootReference']);
 expect(routing.split('\n').length-1).toBeLessThanOrEqual(900);
});
