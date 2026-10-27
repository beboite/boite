import {test,expect} from 'bun:test';
import {runControlBatches} from './control-schedule.ts';
import {fixture} from './stdio-reference-fixture.ts';
import {measureStdioRootReferences} from './stdio-root-reference.ts';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

test('diagnostic pairs wait for prior captures and join both concurrent arms before admitting the next pair',async()=>{
 const background=deferred(),firstFinishing=deferred(),firstEntered=deferred(),firstJoined=deferred();
 const events:string[]=[],fixtures:ReturnType<typeof fixture>[]=[],readyTimes:number[]=[];
 const pair=(name:string,blocked=false)=>async()=>{
  events.push(name+':start');const f=fixture();fixtures.push(f);readyTimes.push(f.frames[0]!.ready);
  const helpers=new Set<number>(),firstObserver=deferred();
  const observe=f.deps.observe,finish=f.deps.finish;
  const control=await measureStdioRootReferences(f.inputs,{...f.deps,
   observe:async(r,path,phase)=>{if(phase==='baseline'){helpers.add(r.helper.pid);if(helpers.size===2)firstObserver.resolve();await firstObserver.promise;}return observe(r,path,phase);},
   finish:async(r,h)=>{if(blocked){firstEntered.resolve();await firstFinishing.promise;}return finish(r);},
  });
  expect(control.protocolValid,control.error).toBe(true);expect(control.helpersJoined).toBe(true);expect(helpers.size).toBe(2);expect(f.joined).toBe(12);
  expect(control.deadline).toBe(f.frames[0]!.deadline);expect(control.deadline-f.frames[0]!.ready).toBe(3000);
  events.push(name+':joined');if(blocked)firstJoined.resolve();
 };
 const started=Date.now(),run=runControlBatches([background.promise],[pair('first',true),pair('second')]);
 try{
  await Promise.resolve();await Promise.resolve();expect(events).toEqual([]);
  background.resolve();await firstEntered.promise;expect(events).toEqual(['first:start']);
  firstFinishing.resolve();await firstJoined.promise;const results=await run;
  expect(events).toEqual(['first:start','first:joined','second:start','second:joined']);expect(results.map(r=>r.status)).toEqual(['fulfilled','fulfilled']);
  expect(readyTimes).toHaveLength(2);expect(readyTimes.every(t=>t>=started-10)).toBe(true);
 }finally{background.resolve();firstFinishing.resolve();await run;for(const f of fixtures)f.cleanup();}
});

test('a failed earlier capture or synchronous paired launch does not skip later complete controls or hide its failure',async()=>{
 const failed=Promise.reject(Error('earlier capture failed')),fixtures:ReturnType<typeof fixture>[]=[],events:string[]=[];
 const run=runControlBatches([failed],[()=>{events.push('refused');throw Error('paired launch refused');},async()=>{
  events.push('following:start');const f=fixture();fixtures.push(f);const result=await measureStdioRootReferences(f.inputs,f.deps);
  expect(result.protocolValid,result.error).toBe(true);expect(result.helpersJoined).toBe(true);expect(f.joined).toBe(12);events.push('following:joined');
 }]);
 try{const results=await run;expect(results[0]!.status).toBe('rejected');if(results[0]!.status==='rejected')expect(String(results[0]!.reason)).toContain('paired launch refused');expect(results[1]!.status).toBe('fulfilled');expect(events).toEqual(['refused','following:start','following:joined']);}
 finally{await run;for(const f of fixtures)f.cleanup();}
});
