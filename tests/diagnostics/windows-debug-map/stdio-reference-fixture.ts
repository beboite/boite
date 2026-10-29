import {mkdtempSync,rmSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {expect} from 'bun:test';
import {encodeStdioReceipt,stdioLabels,type StdioReceipt} from './stdio-root-fence.ts';
import {FaultRootOwner,validateFaultNativeEvidence,type RootRequest,type RootOwned} from './fault-root-reference.ts';
import {authorizeActiveFence} from './live-fence-dispatch.ts';
import {LiveRootDrainer} from './live-root-drain.ts';
export const frame=(role=2,now=1000):StdioReceipt=>({version:1,phase:1,role,result:125,helper:10+role,root:20+role,helperCreated:String(100+role),rootCreated:String(200+role),ready:now,at:now+10,deadline:now+3000,rootDeadline:now+5000,nonce:(role===1?'b':'c').repeat(32),compilerNonce:'a'.repeat(32),acquired:1,closed:1,error:0,session:2,cleanup:511,streams:[0,1,2].map(i=>({original:String(100+i),crt:String(100+i),fd:i,type:3,flushAttempted:i?1:0,flushResult:0,closeAttempted:role===2?1:0,closeResult:0,invalid:role===2?1:0,invalidError:role===2?6:0,closeAt:role===2?now+i+1:0}))});
export const request=(f:StdioReceipt,labels:readonly RootRequest['label'][]=stdioLabels):RootRequest=>{const map=`\\Sessions\\2\\BaseNamedObjects\\boite.route.${f.helper}`;return {version:1,compiler:'sdk',compilerNonce:f.compilerNonce,nonce:f.nonce,label:labels[f.role-1]!,phase:'held',helper:{pid:f.helper,created:f.helperCreated},root:{pid:f.root,created:f.rootCreated},names:{map,retired:map+'.retired',unused:map+'.unused'},deadline:f.deadline,reference:null};};
export const observed=(path:string,absent:boolean)=>({path,code:0,timedOut:false,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${+absent} closed=1 error=0\r\n`,err:absent?'':'cleanup object=map-post-exit-observer handle=000000000000018C query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=2 pointers=32772\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n'});
export interface StreamFixtureOptions {decorate?:(f:StdioReceipt)=>void;labels?:readonly RootRequest['label'][];encode?:(f:StdioReceipt)=>Buffer;openOriginals?:boolean;barrierPrefix?:string;stdoutPrefix?:(r:RootRequest)=>string;stdoutWrites?:(r:RootRequest)=>boolean;comparisonAbsent?:(r:RootRequest)=>boolean}
export function fixture(options:StreamFixtureOptions={}){
 const encode=options.encode??encodeStdioReceipt,req=(f:StdioReceipt)=>request(f,options.labels),barrierPrefix=options.barrierPrefix??'stdio';
 const directory=mkdtempSync(join(tmpdir(),'boite-stdio-pair-')),controlDirectory=join(directory,'fault-root-control');mkdirSync(controlDirectory);
 const rows:any[]=[],events:string[]=[],launcher=new Map<number,RootOwned>(),harness=new Map<number,RootOwned>(),replies=new Map<string,Buffer>(),resolvers=new Map<string,(v:any)=>void>();
 const frames=[frame(1,Date.now()-10),frame(2,Date.now()-10)];frames[1]!.ready=frames[0]!.ready;frames[1]!.deadline=frames[0]!.deadline;
 for(const f of frames)options.decorate?.(f);
 if(options.openOriginals)for(const f of frames)for(const s of f.streams)Object.assign(s,{closeAttempted:0,closeResult:0,invalid:0,invalidError:0,closeAt:0});
 const inputs=Object.fromEntries(frames.map((f,i)=>{
  const r=req(f);writeFileSync(join(controlDirectory,r.label+'.ready.bin'),encode(f));
  for(const [role,table] of [['launcher-main',launcher],['harness-main',harness]] as const)for(const [identity,code] of [[r.root,125],[r.helper,259]] as const){
   const x:RootOwned={owner:role,id:role+'/'+identity.pid,threadId:role==='launcher-main'?'native-sdk':'lpac-ANCHOR-FAULT-'+r.label,threadJob:role==='launcher-main'?'7':String(100+i),jobKey:role==='launcher-main'?3:100+i,globalJob:'8',nestingRefused:false,role,handle:identity.pid+100,pid:identity.pid,created:identity.created,exitCode:code,complete:true,closeFailed:false,stage:'tracked'};table.set(x.pid,x);
   rows.push({event:'acquired',...x,incarnation:x.created},{event:'owned-membership',...x,threadMember:1});
  }
  return [i?'released':'held',{request:r,ready:encode(f),capturedPid:f.helper,readyObservedAt:Date.now(),...(options.stdoutPrefix?{stdoutMarker:fixtureMarker(r)}:{}),capture:new Promise<any>(res=>resolvers.set(r.label,res))}];
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
  observe:async(r:RootRequest,path:string,phase:string)=>{try{await new Promise(res=>setTimeout(res,2));expect(launcher.get(r.helper.pid)!.exitCode).toBe(259);events.push('observe:'+phase);return observed(path,path!==r.names.retired||(phase==='comparison'&&(options.comparisonAbsent?.(r)??r.label.endsWith('-CLOSED'))));}finally{joined++;}},
  releaseHelper:async(r:RootRequest)=>{
   events.push('helper:'+r.helper.pid);const f=frames.find(f=>f.helper===r.helper.pid)!,at=Date.now(),bytes=encode({...f,phase:2,at}),returned=encode({...f,phase:3,at:Date.now(),acquired:3,closed:3});replies.set(r.label,returned);
   writeFileSync(join(controlDirectory,r.label+'.release.bin'),bytes);writeFileSync(join(controlDirectory,r.label+'.return.bin'),returned);
   const marker=`${barrierPrefix}-fence barrier label=${r.label} nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} ready=${f.ready} deadline=${f.deadline}`;
   const err=[`retirement-timing phase=start mode=live nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} root=${r.root.pid} created=${r.root.created} tid=33`,
    `anchor-overlap phase=start mode=exclusive nonce=${r.nonce} helper=${r.helper.pid} helper-created=${r.helper.created} setter=40`,`anchor-overlap phase=go mode=exclusive nonce=${r.nonce} helper=${r.helper.pid}`,
    `private-map path=${r.names.map} create=0x00000000`,`map-retire named path=${r.names.retired} create=0x00000000`,`directory-twin phase=create role=unused path=${r.names.unused} status=0x00000000 end=1`,
    'anchor-cleanup setter=40 created=300 acquired=5 closed=5 files-acquired=8 files-closed=8 forced=1 exit=125 error=13','cleanup job-active=0',
    ...(options.stdoutPrefix?[`retirement-child-closed pid=${r.root.pid} depth=0 child=${r.root.pid+100} thread=1 process=1`,`retirement-child-closed pid=${r.root.pid+100} depth=1 child=${r.root.pid+200} thread=1 process=1`]:[]),
    ...['root-thread','root-process','job','link','map','retire-named-map','twin-unused-map','twin-attached-open','twin-unused-open'].map(slot=>`cleanup close=${slot} closed=1 error=0`),
    ...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),...['station-restore','desktop','station'].map(action=>`window-cleanup action=${action} success=1 error=0`),
    'caller snapshot=after map=x unchanged=1',`cleanup retired-open phase=final status=0x00000000 absent=0 closed=1 error=0 path=${r.names.retired}`,
    'execution.windows.routing.cleanup.final-map: native call failed (13); no unprotected fallback',marker,''].join('\r\n');
   launcher.get(r.helper.pid)!.exitCode=125;resolvers.get(r.label)!({pid:r.helper.pid,code:125,timedOut:false,out:(options.stdoutPrefix?.(r)??'')+((options.stdoutWrites?.(r)??true)?marker+'\r\n':''),err});return {bytes,publishStartedAt:at,publishFinishedAt:Date.now()};
  },readReturn:(r:RootRequest)=>replies.get(r.label)!,finish:async(r:RootRequest)=>({postHelper:Object.values(r.names).map(p=>observed(p,true)),priorCleanupPassed:false})};
 return {directory,controlDirectory,frames,inputs,deps,rows,events,launcher,harness,owner,resolvers,get joined(){return joined;},cleanup(){rmSync(directory,{recursive:true,force:true});}};
}
export function fixtureMarker(r:RootRequest){return 'TASK_ROUTE_ANCHOR-FAULT-'+r.label+'_'+'d'.repeat(32);}
export function assignedStdout(r:RootRequest):string {
 const marker=fixtureMarker(r),pids=[r.root.pid,r.root.pid+100,r.root.pid+200],lines:string[]=[];
 for(let d=0;d<3;d++){const label=marker+'.generation-'+d;
  lines.push(`inspect-start=${label} pid=${pids[d]}`,`${label} appcontainer=1 in-job=1 routing=${d===0?1:0} bytes=${d===0?Buffer.byteLength(marker):0} open-error=${d===0?0:5} marker=${d===0?marker:''}`,`${label} ambient-denial=5`,`${label} debug-object-query=0xc0000353 handle=0000000000000000`,`${label} host-debug-control=0 known=1`);
  if(d<2)lines.push(`${label} child-created=1 pid=${pids[d+1]} error=0`);
 }
 for(let d=2;d>=0;d--)lines.push(`${marker}.generation-${d} inspect-exit=1 child-exit=${d===2?0:1} forced=0`);
 return lines.join('\r\n')+'\r\n';
}
