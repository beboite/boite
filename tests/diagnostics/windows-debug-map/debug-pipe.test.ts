import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {validateDebugPipe} from './debug-pipe.ts';
import type {Captured} from './capture.ts';
import {Journal} from '../../../packages/core/src/journal.ts';
import {Bus} from '../../../packages/core/src/bus.ts';
import {ProcRegistry} from '../../../packages/core/src/procs.ts';
import {capture} from './capture.ts';
import {selectedEnvironment} from './environment.ts';
import {generate,sourcePath} from './generate.ts';

test('normal DEBUG stdout cleanup runs after owned cleanup and before the original map gate',()=>{
 const c=generate(readFileSync(sourcePath,'utf8'));
 expect(c.includes('debug-pipe-held-run')).toBe(true);
 expect(c.includes('debug-pipe-closed-run')).toBe(true);
 const close=c.indexOf('debug_pipe_cleanup(child.dwProcessId)');
 expect(close).toBeGreaterThan(c.indexOf('stream-cleanup index='));
 expect(close).toBeGreaterThan(c.indexOf('window-cleanup action=station'));
 expect(close).toBeGreaterThan(c.indexOf('close_owned(L"root-process"'));
 expect(close).toBeLessThan(c.indexOf('DWORD cleanup = map_close();'));
 expect(c).toContain('if (cleanup && !error) { error = cleanup; stage = L"routing.cleanup.debug-pipe"; }');
});

function fixture(role:1|2):{h:Captured;marker:string}{
 const marker=`TASK_ROUTE_DEBUG-PIPE-${role===1?'HELD':'CLOSED'}_`+'a'.repeat(32),out:string[]=[];
 for(let i=0;i<3;i++){
  const label=marker+'.generation-'+i;
  out.push(`inspect-start=${label} pid=${21+i}`,`${label} appcontainer=1 in-job=1 routing=1 bytes=${Buffer.byteLength(marker)} open-error=0 marker=${marker}`,`${label} ambient-denial=5`,`${label} debug-object-query=0xc0000022 handle=0000000000000000`,`${label} host-debug-control=0 known=1`,`${label} application-exception-forwarded=1 handler-removed=1`);
  if(i<2)out.push(`${label} child-created=1 pid=${22+i} error=0`);
 }
 for(let i=2;i>=0;i--)out.push(`${marker}.generation-${i} inspect-exit=0 child-exit=0 forced=0`);
 const err=['private-map path=\\Sessions\\2\\BaseNamedObjects\\boite.route.11 create=0x00000000',
  'cleanup job-active=0','debug-drain cleanup=1 captured=6 remaining=0 error=0',
  ...['root-thread','root-process','job'].map(s=>`cleanup close=${s} closed=1 error=0`),
  ...[0,1,2].map(i=>`stream-cleanup index=${i} success=1 error=0`),
  ...['station-restore','desktop','station'].map(s=>`window-cleanup action=${s} success=1 error=0`),
  `debug-pipe barrier helper=11 root=21 role=${role} at=100`,
  ...[0,1,2].map(i=>`debug-pipe stream=${i} original=${100+i} crt=${100+i} fd=${i} type=3 flush-attempted=${i===0?0:1} flush-result=0 close-attempted=${role===2&&i===1?1:0} close-result=0 invalid=${role===2&&i===1?1:0} invalid-error=${role===2&&i===1?6:0} close-at=${role===2&&i===1?101:0}`),
  `debug-pipe result helper=11 root=21 role=${role} mask=511 begin=100 at=102 error=0`,
  'cleanup object=map-before-link-close handle=1 query=0x00000000'];
 return {marker,h:{pid:11,code:role===1?125:0,timedOut:false,out:out.join('\r\n')+'\r\n',err:err.join('\r\n')+'\r\n'}};
}
test('normal cleanup authenticates exact stdout, fd1-only closure and its position before map cleanup',()=>{
 for(const role of [1,2] as const){const {h,marker}=fixture(role);const proof=validateDebugPipe(h,marker,role);expect(proof.streams.filter(s=>s.closed).map(s=>s.fd)).toEqual(role===1?[]:[1]);expect(proof.productionAccepted).toBe(false);}
 const {h,marker}=fixture(2);
 expect(validateDebugPipe({...h,out:h.out.replaceAll('debug-object-query=0xc0000022','debug-object-query=0xc0000353')},marker,2).role).toBe(2);
 const reject=(next:Captured)=>expect(()=>validateDebugPipe(next,marker,2)).toThrow('normal DEBUG stdout cleanup:');
 reject({...h,timedOut:true});reject({...h,pid:12});reject({...h,code:null});
 for(const label of [marker+'Xgeneration-0',marker+'\\generation-0',marker+'.generation-00'])reject({...h,out:h.out.replace(marker+'.generation-0 debug-object-query',label+' debug-object-query')});
 reject({...h,out:h.out.replace('debug-object-query=0xc0000022','debug-object-query=0x00000000')});
 reject({...h,out:h.out+'!'});reject({...h,out:h.out.replace('ambient-denial=5','ambient-denial=0')});
 for(const [before,after] of [
  ['helper=11','helper=12'],['root=21','root=24'],['mask=511','mask=510'],['error=0\r\ncleanup object=','error=5\r\ncleanup object='],
  ['original=101 crt=101','original=100 crt=100'],['crt=101','crt=999'],['fd=1','fd=0'],['type=3','type=1'],
  ['flush-attempted=1','flush-attempted=0'],['close-attempted=1','close-attempted=0'],['close-result=0 invalid=1','close-result=-1 invalid=1'],
  ['invalid-error=6','invalid-error=0'],['close-at=101','close-at=99'],['close-at=101','close-at=103'],
  ['cleanup close=root-process closed=1','cleanup close=root-process closed=0'],['debug-drain cleanup=1 captured=6','debug-drain cleanup=1 captured=5'],
 ] as const){expect(h.err.includes(before)).toBe(true);reject({...h,err:h.err.replace(before,after)});}
 const proof=h.err.match(/debug-pipe barrier[^]*?error=0\r\n(?=cleanup object=)/)![0];
 reject({...h,err:proof+h.err.replace(proof,'')});
 reject({...h,err:h.err.replace(proof,'')+proof});
 reject({...h,err:h.err+proof});
 reject({...h,err:h.err+'map-retire named path=anything\r\n'});
});

test.skipIf(process.platform==='win32'||!Bun.which('cc'))('actual DEBUG cleanup guard rejects premature cleanup and propagates stream failures',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'boite-debug-pipe-')),journal=new Journal(join(dir,'journal.db')),procs=new ProcRegistry(journal,new Bus());
 try{
  const actual=readFileSync(join(import.meta.dir,'debug-pipe.h'),'utf8');
  for(const [name,source] of [
   ['actual',actual],
   ['missing-mask',actual.replace('lf_cleanup_mask != 0x1ff','(0 && lf_cleanup_mask != 0x1ff)')],
   ['wrong-experiment',actual.replace('sf_streams(&f, marker, 4)','sf_streams(&f, marker, 0)')],
   ['lost-error',actual.replace('DWORD error = sf_streams(&f, marker, 4);','DWORD error = 0; (void)sf_streams(&f, marker, 4);')],
  ]){
   expect(name==='actual'||source!==actual).toBe(true);writeFileSync(join(dir,'debug-pipe-function.h'),source!);
   const build=await capture(procs,'debug-pipe-cc',procs.spawnPiped('debug-pipe-cc',Bun.which('cc')!,['-std=c11','-Wall','-Wextra','-Werror','-I',dir,join(import.meta.dir,'debug-pipe-cases.c'),'-o',join(dir,'cases')],{cwd:dir,env:selectedEnvironment(),agentRoot:false}),15000);
   expect(build.timedOut).toBe(false);expect(build.code,build.err).toBe(0);
   const run=async(args:string[])=>capture(procs,'debug-pipe-cases',procs.spawnPiped('debug-pipe-cases',join(dir,'cases'),args,{cwd:dir,env:selectedEnvironment(),agentRoot:false}),5000);
   const result=await run([]);expect(result.timedOut).toBe(false);expect(result.code,result.err).toBe(name==='actual'?0:1);
   if(name==='actual'){
    expect(result.out).toContain('DEBUG_PIPE_GUARDS_PASS');
    for(const role of [1,2] as const){const encoded=await run([String(role)]);expect(encoded.code,encoded.err).toBe(0);const {h,marker}=fixture(role);const proof=h.err.match(/debug-pipe barrier[^]*?error=0\r\n(?=cleanup object=)/)![0];
     const evidence=validateDebugPipe({...h,err:h.err.replace(proof,encoded.err.replace(/\n/g,'\r\n'))},marker,role);expect(evidence.role).toBe(role);
    }
   }else console.log(`DEBUG_PIPE_MUTATION_REJECTED ${name} compile=0 runtime=1`);
  }
 }finally{await procs.killAll();await procs.close();journal.close();rmSync(dir,{recursive:true,force:true});}
},30000);
