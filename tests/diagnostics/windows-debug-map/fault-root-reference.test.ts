import {mkdtempSync,rmSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,expect} from 'bun:test';
import {FaultRootOwner,parseRootRequest,measureFaultRootReference,otherRootReferencesDrained,validateFaultNativeEvidence,startFaultRootService,requestRootReference,type RootRequest}  from './fault-root-reference.ts';
const request = () => ({version:1,compiler:'sdk',compilerNonce:'a'.repeat(32),nonce:'b'.repeat(32),label:'ASSIGNED',phase:'held',helper:{pid:11,created:'100'},root:{pid:22,created:'200'},names:{map:'\\Sessions\\2\\BaseNamedObjects\\boite.route.11',retired:'\\Sessions\\2\\BaseNamedObjects\\boite.route.11.retired',unused:'\\Sessions\\2\\BaseNamedObjects\\boite.route.11.unused'},deadline:2000,reference:null});
// SDK and MinGW f751c4c5 retained-name observers emit these successful
// query/close records on stderr; absent-name observers emit no stderr.
const retainedCleanup='cleanup object=map-post-exit-observer handle=000000000000018C query=0x00000000 attributes=0x00000000 granted=0x00000001 handles=2 pointers=32772\r\ncleanup close=map-post-exit-observer closed=1 error=0\r\n';
function fixture(){
 let live:any={handle:99,pid:22,created:'200',exitCode:125,owner:'owner',role:'launcher-main',id:'ref/1',threadId:'native-sdk',threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,complete:true,closeFailed:false,stage:'tracked'};
 let count=0, now=1000, failure=false;
 const owner=new FaultRootOwner({compiler:'sdk',compilerNonce:'a'.repeat(32),now:()=>now,current:()=>live,authorize:()=>{},removed:()=>live===undefined,retire:()=>{count++;live=undefined;return {id:'ref/1',success:!failure,error:failure?6:0,wallMs:now};}});
 return {owner,get live(){return live;},set live(v){live=v;},get count(){return count;},set now(v:number){now=v;},set failure(v:boolean){failure=v;}};
}
test('exact owner release retires one reference and rejects replay',()=>{
 const f=fixture(),r:any=request();const held=f.owner.handle(r);expect(held.error).toBeNull();expect(f.count).toBe(0);
 r.reference=held.sample;r.phase='verified';expect(f.owner.handle(r).error).toBeNull();
 r.phase='release';expect(f.owner.handle(r).close!.success).toBe(true);expect(f.count).toBe(1);
 expect(()=>f.owner.handle(r)).toThrow();expect(f.count).toBe(1);
});

test('wrong identities, live root, owner/job, missing ledger and deadline never authorize close',()=>{
 for(const patch of [{created:'201'},{pid:23},{exitCode:259},{role:'harness-main'},{threadId:'native-mingw'},{complete:false},{closeFailed:true},{stage:'acquired'},{id:''}]){
  const f=fixture();Object.assign(f.live,patch);expect(()=>f.owner.handle(request() as RootRequest)).toThrow();expect(f.count).toBe(0);
 }
 for(const patch of [{compilerNonce:'c'.repeat(32)},{deadline:999},{deadline:4001},{compiler:'mingw'}]){const f=fixture();expect(()=>f.owner.handle({...request(),...patch} as RootRequest)).toThrow();expect(f.count).toBe(0);}
});
test('changed custody, failed actual close and duplicate release cannot retry a numeric value',()=>{
 for(const fail of [false,true]){
  const f=fixture(),r:any=request(),held=f.owner.handle(r);r.reference=held.sample;r.phase='verified';f.owner.handle(r);r.phase='release';
  if(fail)f.failure=true;else f.live.created='999';
  expect(()=>f.owner.handle(r)).toThrow();const count=f.count;
  if(f.live)f.live.created='200';expect(()=>f.owner.handle(r)).toThrow();expect(f.count).toBe(count);expect(count).toBe(fail?1:0);
 }
});
test('strict fixed request rejects extra fields, partial data, names and nested identity changes',()=>{
 for(const r of [{...request(),handle:99},{...request(),helper:{pid:11,created:'100',handle:99}},{...request(),names:{...request().names,retired:'other'}},{...request(),phase:'release'},{...request(),phase:['held']},{...request(),label:['ASSIGNED']}])expect(()=>parseRootRequest(JSON.stringify(r),1000)).toThrow();
 expect(()=>parseRootRequest('{',1000)).toThrow();expect(()=>parseRootRequest(' '.repeat(9000),1000)).toThrow();
});
test('observer failures join every observer before returning and never release',async()=>{
 const f=fixture(),r=request() as RootRequest;let joined=0;
 const result=await measureFaultRootReference(r,{now:()=>1000,rows:()=>[{event:'acquired',id:'ref/1',pid:22,incarnation:'200',owner:'owner',role:'launcher-main'},{event:'acquired',id:'ref/2',pid:22,incarnation:'200',owner:'harness',role:'harness-main'},{event:'close-result',owner:'harness',role:'harness-main',id:'ref/2',pid:22,incarnation:'200',success:true,error:0}],exchange:async req=>f.owner.handle(req),observe:async()=>{try{await new Promise(resolve=>setTimeout(resolve,5));throw new Error('observer');}finally{joined++;}}});
 expect(joined).toBe(3);expect(result.protocolValid).toBe(false);expect(result.error).toContain('observers');expect(f.count).toBe(0);
});

test('private transport binds all phases and records a separate held/released observation',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'boite-root-reference-')),f=fixture(),started=Date.now();f.now=started;
 const r={...request(),deadline:started+3000} as RootRequest;
 const service=startFaultRootService(directory,f.owner,action=>action());
 try {
  const rows:any[]=[{event:'acquired',id:'ref/1',pid:22,incarnation:'200',owner:'owner',role:'launcher-main'},{event:'acquired',id:'ref/2',pid:22,incarnation:'200',owner:'harness',role:'harness-main'},{event:'close-result',owner:'harness',role:'harness-main',id:'ref/2',pid:22,incarnation:'200',success:true,error:0}];
  const record=await measureFaultRootReference(r,{exchange:req=>requestRootReference(directory,req,action=>action()),now:()=>Date.now(),rows:()=>f.count?[...rows,{event:'close-result',owner:'owner',role:'launcher-main',id:'ref/1',pid:22,incarnation:'200',success:true,error:0}]:rows,
   observe:async(path,phase)=>{const absent=phase==='released'||path!==r.names.map?1:0;return {path,code:0,timedOut:false,err:absent?'':retainedCleanup,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${absent} closed=1 error=0\r\n`};}});
  expect(record.error).toBeUndefined();expect(record.protocolValid).toBe(true);expect(record.outcome).toBe('disappearance-after-owned-release');expect(record.causeConfirmed).toBe(false);expect(f.count).toBe(1);expect(readdirSync(directory).length).toBe(6);
  let replay:unknown;try{await requestRootReference(directory,{...r,phase:'release',reference:record.held!.sample},action=>action());}catch(error){replay=error;}expect(String(replay)).toContain('replayed file');expect(f.count).toBe(1);
  const held=record.held!.sample!;expect(otherRootReferencesDrained(r,held,rows)).toBe(true);expect(otherRootReferencesDrained(r,held,rows.filter(x=>x.event!=='close-result'))).toBe(false);
 }finally{await service.stop();rmSync(directory,{recursive:true,force:true});}
});

test('native evidence binds the completed helper, exact created names and owner topology',()=>{
 const f=fixture(),r=request() as RootRequest;
 const raw=`pid=11 exit=125 timedOut=false\nretirement-timing phase=start mode=live nonce=${r.nonce} helper=11 helper-created=100 root=22 created=200 tid=33\nprivate-map path=${r.names.map} create=0x00000000\nmap-retire named path=${r.names.retired} create=0x00000000\ndirectory-twin phase=create role=unused path=${r.names.unused} status=0x00000000 end=1\ncleanup job-active=0\n`;
 const rows:any[]=[r.helper,r.root].map(p=>({event:'owned-membership',role:'launcher-main',owner:'owner',...p,threadId:'native-sdk',threadJob:'7',jobKey:3,globalJob:'8',nestingRefused:false,threadMember:1}));
 expect(()=>validateFaultNativeEvidence(r,f.live,raw,rows)).not.toThrow();
 for(const bad of [raw.replace('exit=125','exit=0'),raw.replace('job-active=0','job-active=1'),raw.replace('created=200','created=201'),raw.replace(r.names.unused,'wrong')])expect(()=>validateFaultNativeEvidence(r,f.live,bad,rows)).toThrow();
 expect(()=>validateFaultNativeEvidence(r,f.live,raw,rows.slice(0,1))).toThrow();expect(f.count).toBe(0);
});

test('other reference drains before every held observation without extending the deadline',async()=>{
 const f=fixture(),started=Date.now();f.now=started;const r={...request(),deadline:started+3000} as RootRequest;let drained=false,sawOpen=false;
 const timer=setTimeout(()=>{drained=true;},20);
 const rows=()=>[{event:'acquired',id:'ref/1',pid:22,incarnation:'200',owner:'owner',role:'launcher-main'},{event:'acquired',id:'ref/2',pid:22,incarnation:'200',owner:'harness',role:'harness-main'},...(drained?[{event:'close-result',owner:'harness',role:'harness-main',id:'ref/2',pid:22,incarnation:'200',success:true,error:0}]:[]),...(f.count?[{event:'close-result',owner:'owner',role:'launcher-main',id:'ref/1',pid:22,incarnation:'200',success:true,error:0}]:[])];
 try{
  const record=await measureFaultRootReference(r,{now:()=>Date.now(),exchange:async req=>f.owner.handle(req),rows,
   observe:async(path,phase)=>{if(!drained)sawOpen=true;const absent=phase==='released'||path!==r.names.map?1:0;return {path,code:0,timedOut:false,err:absent?'':retainedCleanup,out:`map-after-helper-exit path=${path} open=${absent?'0xc0000034':'0x00000000'} absent=${absent} closed=1 error=0\r\n`};}});
  expect(record.protocolValid).toBe(true);expect(sawOpen).toBe(false);expect(record.request.deadline).toBe(r.deadline);expect(f.count).toBe(1);
 }finally{clearTimeout(timer);}
});

test('retained observer failures or missing close proof never release the owned root',async()=>{
 const invalid=[
  '', retainedCleanup.replace('closed=1 error=0','closed=0 error=6'),
  retainedCleanup.replace('query=0x00000000','query=0xc0000001'),
  retainedCleanup.replace('granted=0x00000001','granted=0x000f000f'),
  retainedCleanup.replaceAll('map-post-exit-observer','other-object'),
  retainedCleanup+retainedCleanup,retainedCleanup+'unexpected diagnostic\r\n',
 ];
 for(const err of invalid){
  const f=fixture(),r=request() as RootRequest;
  const rows:any[]=[{event:'acquired',id:'ref/1',pid:22,incarnation:'200',owner:'owner',role:'launcher-main'},{event:'acquired',id:'ref/2',pid:22,incarnation:'200',owner:'harness',role:'harness-main'},{event:'close-result',owner:'harness',role:'harness-main',id:'ref/2',pid:22,incarnation:'200',success:true,error:0}];
  const record=await measureFaultRootReference(r,{now:()=>1000,rows:()=>rows,exchange:async req=>f.owner.handle(req),
   observe:async path=>({path,code:0,timedOut:false,err,out:`map-after-helper-exit path=${path} open=0x00000000 absent=0 closed=1 error=0\r\n`})});
  expect(record.protocolValid).toBe(false);expect(record.error).toContain('exact observer output');expect(f.count).toBe(0);
 }
});
test('service errors preserve RootReply fields and the actual owner rejection',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'boite-root-error-')),f=fixture(),started=Date.now();f.now=started;const service=startFaultRootService(directory,f.owner,action=>action());
 try{
  const r={...request(),root:{pid:22,created:'201'},deadline:started+3000} as RootRequest;
  let error:unknown;try{await requestRootReference(directory,r,action=>action());}catch(cause){error=cause;}
  expect(String(error)).toContain('exact terminal owned root');
  const raw=JSON.parse(readFileSync(join(directory,'ASSIGNED.held.response.json'),'utf8'));expect(raw.sample).toBeNull();expect(raw.close).toBeNull();expect(f.count).toBe(0);
 }finally{await service.stop();rmSync(directory,{recursive:true,force:true});}
});
