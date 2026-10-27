import {frame,request,observed,fixture} from './stdio-reference-fixture.ts';
import {test,expect} from 'bun:test';
import {encodeStdioReceipt,parseStdioReceipt,type StdioReceipt} from './stdio-root-fence.ts';

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
