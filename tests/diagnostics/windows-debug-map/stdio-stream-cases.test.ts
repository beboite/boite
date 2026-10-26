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
  for(const [name,source,rejected] of [
   ['actual',actual,''],
   ['count-zero',actual.replace('&buffer,1,&call->transferred','&buffer,0,&call->transferred'),'byte exact original stdout valid exclamation count one synchronous'],
   ['wrong-payload',actual.replace("BYTE buffer='!'", "BYTE buffer='?'"),'byte exact original stdout valid exclamation count one synchronous'],
   ['close-stdout-marker',actual.replace('(!experiment || (experiment==1', '(!experiment || experiment==4 || (experiment==1'),'stdout close common stderr flush then only fd1 closure'],
   ['close-raw-write',actual.replace('experiment==3 ? sf_byte_write', '(experiment==3 || experiment==4) ? sf_byte_write'),'stdout close explicit native path succeeds'],
   ['close-wrong-index',actual.replace('(experiment==4 && i==1)', '(experiment==4 && i==0)'),'stdout close common stderr flush then only fd1 closure'],
   ['close-multiple',actual.replace('(experiment==4 && i==1)', '(experiment==4 && i>=1)'),'stdout close common stderr flush then only fd1 closure'],
   ['close-missing',actual.replace('(experiment==4 && i==1)', '(experiment==4 && i==3)'),'stdout close common stderr flush then only fd1 closure'],
   ['close-no-invalidity-check',actual.replace('if(s->close_result || !s->invalid || s->invalid_error!=ERROR_INVALID_HANDLE)', 'if(s->close_result || (experiment!=4 && (!s->invalid || s->invalid_error!=ERROR_INVALID_HANDLE)))'),'stdout close bad preflight flush close or invalidity rejects'],
   ['close-no-close-result-check',actual.replace('if(s->close_result || !s->invalid || s->invalid_error!=ERROR_INVALID_HANDLE)', 'if((experiment!=4 && s->close_result) || !s->invalid || s->invalid_error!=ERROR_INVALID_HANDLE)'),'stdout close fclose failure rejects even if handle became invalid'],
  ] as const){
  expect(rejected?source!==actual:source===actual).toBe(true);
  writeFileSync(join(dir,'stdio-stream-function.h'),source);
  const built=await capture(procs,'compile-stdio',procs.spawnPiped('compile-stdio',compiler!,['-std=c11','-Wall','-Wextra','-Werror','-I',dir,join(import.meta.dir,'stdio-stream-cases.c'),'-o',join(dir,'cases')],{cwd:dir,env:selectedEnvironment(),agentRoot:false}),15000);
  expect(built.timedOut).toBe(false);expect(built.code,built.err).toBe(0);
  const result=await capture(procs,'stdio-cases',procs.spawnPiped('stdio-cases',join(dir,'cases'),[],{cwd:dir,env:selectedEnvironment(),agentRoot:false}),5000);
  expect(result.timedOut).toBe(false);if(rejected){expect(result.code).toBe(1);expect(result.err).toContain(rejected);console.log(`${name.startsWith('close-')?'STDOUT_CLOSE':'STDOUT_BYTE'}_MUTATION_REJECTED ${name} compile=0 runtime=1`);}
  else{expect(result.code,result.err).toBe(0);expect(result.out).toContain('STDIO_STREAM_GUARDS_PASS');console.log(result.out.trim());}
  }
 }finally{await procs.killAll();await procs.close();journal.close();rmSync(dir,{recursive:true,force:true});}
},30000);
