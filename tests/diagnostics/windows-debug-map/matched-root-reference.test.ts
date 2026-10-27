import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FaultRootOwner,startFaultRootService,requestRootReference,type RootRequest,type RootOwned,type RootObservation} from './fault-root-reference.ts';
import {measureMatchedRootReferences} from './matched-root-reference.ts';

const cleanup='cleanup object=map-post-exit-observer handle=000000000000018C query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=2 pointers=32772\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n';
const observed=(path:string,absent:boolean):RootObservation=>({path,code:0,timedOut:false,err:absent?'':cleanup,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${+absent} closed=1 error=0\r\n`});
function fixture(realTime=false){
 let clock=realTime?Date.now():1000;
 const now=()=>realTime?Date.now():++clock,deadline=now()+3000;
 const rows:any[]=[],live=new Map<number,RootOwned>(),closeCalls:number[]=[],events:string[]=[],oldFlags=[false,false];
 const arms=Object.fromEntries(['held','released'].map((arm,index)=>{
  const helper=11+index,root=21+index,map=`\\Sessions\\2\\BaseNamedObjects\\boite.route.${helper}`;
  const request:RootRequest={version:1,compiler:'sdk',compilerNonce:'a'.repeat(32),nonce:(index?'c':'b').repeat(32),label:`ASSIGNED-PAIR-${arm.toUpperCase()}` as RootRequest['label'],phase:'held',helper:{pid:helper,created:String(100+index)},root:{pid:root,created:String(200+index)},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline,reference:null};
  live.set(root,{owner:'owner',id:`ref/${root}`,threadId:'native-sdk',threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,handle:100+root,pid:root,created:request.root.created,exitCode:125,role:'launcher-main',complete:true,closeFailed:false,stage:'tracked'});
  rows.push({event:'acquired',id:`ref/${root}`,pid:root,incarnation:request.root.created,owner:'owner',role:'launcher-main'},
   {event:'acquired',id:`other/${root}`,pid:root,incarnation:request.root.created,owner:'harness',role:'harness-main'},
   {event:'close-result',id:`other/${root}`,pid:root,incarnation:request.root.created,owner:'harness',role:'harness-main',success:true,error:0,wallMs:now()});
  const err=[`retirement-timing phase=start mode=live nonce=${request.nonce} helper=${helper} helper-created=${request.helper.created} root=${root} created=${request.root.created} tid=33`,
   `anchor-overlap phase=start mode=exclusive nonce=${request.nonce} helper=${helper} helper-created=${request.helper.created} setter=40 setter-created=300 root=${root} created=${request.root.created} tid=33 end=1`,
   `anchor-overlap phase=go mode=exclusive nonce=${request.nonce} helper=${helper} end=1`,
   'anchor-cleanup setter=40 created=300 acquired=5 closed=5 files-acquired=8 files-closed=8 forced=1 exit=125 error=13',
   'cleanup job-active=0',...['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'].map(slot=>`cleanup close=${slot} closed=1 error=0`),
   'caller snapshot=after map=x unchanged=1'].join('\r\n')+'\r\n';
  return [arm,{request,helper:{pid:helper,code:125,timedOut:false,out:'',err},postHelper:Object.values(request.names).map(path=>observed(path,path!==request.names.retired)),priorCleanupPassed:oldFlags[index]}];
 })) as any;
 const nativeClose=(pid:number)=>{
  const x=live.get(pid)!;live.delete(pid);const close={id:x.id,success:true,error:0,wallMs:now()};rows.push({event:'close-result',...close,pid,incarnation:x.created,owner:x.owner,role:x.role});return close;
 };
 const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:'a'.repeat(32),now,current:pid=>live.get(pid),removed:pid=>!live.has(pid),authorize:()=>{},retire:x=>{closeCalls.push(x.pid);events.push(`close:${x.pid}`);return nativeClose(x.pid);}});
 let comparisonJoined=0,baselineJoined=0;
 const deps={now,rows:()=>rows,exchange:async(r:RootRequest)=>owner.handle(r),observe:async(r:RootRequest,path:string,phase:string)=>{
  if(phase==='comparison'){expect(live.has(21)).toBe(true);expect(live.has(22)).toBe(false);}
  await new Promise(resolve=>setTimeout(resolve,path.endsWith('.retired')?5:2));
  if(phase==='baseline')baselineJoined++;if(phase==='comparison')comparisonJoined++;
  events.push(`${phase}:${r.label}:${path}`);
  return observed(path,path!==r.names.retired||!live.has(r.root.pid));
 }};
 return {arms,deps,live,rows,closeCalls,events,oldFlags,nativeClose,now,get baselineJoined(){return baselineJoined;},get comparisonJoined(){return comparisonJoined;},set clock(v:number){clock=v;}};
}
test('same-time comparison keeps HELD through all six captures, then closes each exact owner once',async()=>{
 const f=fixture(),record=await measureMatchedRootReferences(f.arms,f.deps);
 expect(record.protocolValid).toBe(true);expect(record.outcome).toBe('held-retained-released-absent');
 expect(f.baselineJoined).toBe(6);expect(f.comparisonJoined).toBe(6);expect(f.closeCalls).toEqual([22,21]);
 expect(record.arms.held.released!.close!.wallMs).toBeGreaterThan(record.comparisonWindow!.end);
 expect(record.arms.held.request.deadline).toBe(f.arms.released.request.deadline);
 expect(record.arms.held.baseline).toHaveLength(3);expect(record.arms.released.comparison).toHaveLength(3);
 expect(f.oldFlags).toEqual([false,false]);expect(record.arms.held.priorCleanupPassed).toBe(false);
 expect(record.causeConfirmed).toBe(false);expect(record.productionAccepted).toBe(false);
 expect(f.events.indexOf('close:21')).toBeGreaterThan(f.events.findLastIndex(e=>e.startsWith('comparison:')));
});

test('natural HELD closure or changed identity during the shared window never closes a substitute',async()=>{
 for(const change of ['closed','identity']){
  const f=fixture();const observe=f.deps.observe;let changed=false;
  f.deps.observe=async(r,path,phase)=>{if(phase==='comparison'&&!changed){changed=true;if(change==='closed')f.nativeClose(21);else f.live.get(21)!.created='999';}
   if(phase==='comparison'){await new Promise(resolve=>setTimeout(resolve,3));return observed(path,path!==r.names.retired||!f.live.has(r.root.pid));}return observe(r,path,phase);};
  const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(f.closeCalls).toEqual([22]);expect(record.outcome).toBe('inconclusive');
 }
});

test('both arms drain before any baseline and retain one unchanged absolute deadline',async()=>{
 const f=fixture();const withheld=f.rows.splice(f.rows.findIndex(r=>r.id==='other/21'&&r.event==='close-result'),1)[0];let observedOpen=false;
 const observe=f.deps.observe;f.deps.observe=async(r,path,phase)=>{if(!f.rows.includes(withheld))observedOpen=true;return observe(r,path,phase);};
 const timer=setTimeout(()=>f.rows.push(withheld),10);
 try{const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(true);expect(observedOpen).toBe(false);expect(record.deadline).toBe(f.arms.held.request.deadline);}finally{clearTimeout(timer);}
});

test('mismatched or expired deadline, job mismatch and missing other-reference drainage reject the pair',async()=>{
 for(const change of ['deadline','expired','job','other']){
  const f=fixture();if(change==='deadline')f.arms.released.request.deadline++;if(change==='expired')f.clock=f.arms.held.request.deadline;
  if(change==='job')f.live.get(22)!.jobKey=4;
  if(change==='other'){f.rows.splice(f.rows.findIndex(r=>r.id==='other/21'&&r.event==='close-result'),1);f.clock=f.arms.held.request.deadline-20;}
  const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(f.closeCalls).toEqual([]);expect(f.baselineJoined).toBe(0);
 }
});

test('native rejection and observer contract failures do not authorize a pair release',async()=>{
 for(const change of ['native','output','unknown-stderr']){
  const f=fixture();if(change==='native')f.arms.held.helper.err=f.arms.held.helper.err.replace('exit=125 error=13','exit=125 error=6');
  const observe=f.deps.observe;f.deps.observe=async(r,path,phase)=>{const o=await observe(r,path,phase);if(r===f.arms.held.request&&phase==='baseline'){if(change==='output')o.out='unknown\r\n';if(change==='unknown-stderr')o.err+='unknown\r\n';}return o;};
  const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(f.closeCalls).toEqual([]);
 }
});

test('a rejected comparison capture joins every delayed observer before cleanup can proceed',async()=>{
 const f=fixture(),observe=f.deps.observe;let settled=0;
 f.deps.observe=async(r,path,phase)=>{if(phase!=='comparison')return observe(r,path,phase);try{await new Promise(resolve=>setTimeout(resolve,path===r.names.map?1:10));if(r===f.arms.held.request&&path===r.names.map)throw Error('capture failed');return observed(path,path!==r.names.retired||!f.live.has(r.root.pid));}finally{settled++;}};
 const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(settled).toBe(6);expect(f.closeCalls).toEqual([22]);
});

test('fixed pair labels use the real private file service for all six existing phases',async()=>{
 const f=fixture(true),directory=mkdtempSync(join(tmpdir(),'boite-matched-root-'));
 const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:'a'.repeat(32),now:f.now,current:pid=>f.live.get(pid),removed:pid=>!f.live.has(pid),authorize:()=>{},retire:x=>{f.closeCalls.push(x.pid);return f.nativeClose(x.pid);}});
 const service=startFaultRootService(directory,owner,action=>action());
 try{const record=await measureMatchedRootReferences(f.arms,{...f.deps,exchange:r=>requestRootReference(directory,r,action=>action())});expect(record.protocolValid).toBe(true);expect(f.closeCalls).toEqual([22,21]);expect(readdirSync(directory)).toHaveLength(12);}finally{await service.stop();rmSync(directory,{recursive:true,force:true});}
});

test('a comparison with a newly retained unused name cannot claim released absence',async()=>{
 const f=fixture(),observe=f.deps.observe;
 f.deps.observe=async(r,path,phase)=>phase==='comparison'&&path===r.names.unused?observed(path,false):observe(r,path,phase);
 const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(record.outcome).toBe('inconclusive');
});

test('elapsed disappearance or persistence remain explicit valid outcomes without a cause claim',async()=>{
 for(const [held,released,outcome] of [[false,false,'both-retained'],[true,true,'both-absent'],[true,false,'held-absent-released-retained']] as const){
  const f=fixture(),observe=f.deps.observe;
  f.deps.observe=async(r,path,phase)=>phase==='comparison'&&path===r.names.retired?observed(path,r.label.endsWith('-HELD')?held:released):observe(r,path,phase);
  const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(true);expect(record.outcome).toBe(outcome);expect(f.closeCalls).toEqual([22,21]);expect(record.causeConfirmed).toBe(false);
 }
});

test('a restarted deadline after baseline or failed RELEASED proof cannot enter the comparison',async()=>{
 for(const change of ['deadline','close']){
  const f=fixture(),exchange=f.deps.exchange;
  f.deps.exchange=async r=>{if(change==='deadline'&&r.phase==='verified')return exchange({...r,deadline:r.deadline+1});const reply=await exchange(r);if(change==='close'&&r.phase==='release'&&r.root.pid===22)return {...reply,close:{...reply.close!,success:false,error:6}};return reply;};
  const record=await measureMatchedRootReferences(f.arms,f.deps);expect(record.protocolValid).toBe(false);expect(f.comparisonJoined).toBe(0);expect(f.closeCalls).toEqual(change==='close'?[22]:[]);expect(f.live.has(21)).toBe(true);
 }
});
