import {test,expect} from 'bun:test';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {Journal} from '../../../packages/core/src/journal.ts';
import {Bus} from '../../../packages/core/src/bus.ts';
import {ProcRegistry} from '../../../packages/core/src/procs.ts';
import {capture} from './capture.ts';import {selectedEnvironment} from './environment.ts';
const compiler=process.platform==='win32'?null:Bun.which('cc');
test.skipIf(!compiler)('the actual native stream guard validates CRT ownership and flush/close/invalidity without closing unknown handles',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'boite-stdio-guards-')),journal=new Journal(join(dir,'journal.db')),procs=new ProcRegistry(journal,new Bus());
 try{const header=readFileSync(join(import.meta.dir,'stdio-root-fence.h'),'utf8');
  const actual=header.split('/* SF_STREAMS_BEGIN: compiled verbatim by the non-native guard regression. */')[1]!.split('/* SF_STREAMS_END */')[0]!;
  for(const [name,source,mutated] of [
   ['actual',actual,false],
   ['count-zero',actual.replace('&buffer,1,&call->transferred','&buffer,0,&call->transferred'),true],
   ['wrong-payload',actual.replace("BYTE buffer='!'", "BYTE buffer='?'"),true],
  ] as const){
  expect(mutated?source!==actual:source===actual).toBe(true);
  writeFileSync(join(dir,'stdio-stream-function.h'),source);
  const built=await capture(procs,'compile-stdio',procs.spawnPiped('compile-stdio',compiler!,['-std=c11','-Wall','-Wextra','-Werror','-I',dir,join(import.meta.dir,'stdio-stream-cases.c'),'-o',join(dir,'cases')],{cwd:dir,env:selectedEnvironment(),agentRoot:false}),15000);
  expect(built.timedOut).toBe(false);expect(built.code,built.err).toBe(0);
  const result=await capture(procs,'stdio-cases',procs.spawnPiped('stdio-cases',join(dir,'cases'),[],{cwd:dir,env:selectedEnvironment(),agentRoot:false}),5000);
  expect(result.timedOut).toBe(false);if(mutated){expect(result.code).toBe(1);expect(result.err).toContain('byte exact original stdout valid exclamation count one synchronous');console.log(`STDOUT_BYTE_MUTATION_REJECTED ${name} compile=0 runtime=1`);}
  else{expect(result.code,result.err).toBe(0);expect(result.out).toContain('STDIO_STREAM_GUARDS_PASS');console.log(result.out.trim());}
  }
 }finally{await procs.killAll();await procs.close();journal.close();rmSync(dir,{recursive:true,force:true});}
},30000);
