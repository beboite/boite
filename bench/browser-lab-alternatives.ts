import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { startTestCore } from '../packages/core/test/harness.ts';
import { findBrowser } from '../tests/e2e/lib/cdp.ts';
import { createBrowserLabEngine } from './browser-lab-engine.ts';
import { BrowserLabRecording } from './browser-lab-recording.ts';
import { labTasks } from './browser-lab-tasks.ts';
import { BrowserLabCodex, type BrowserContentItem } from './browser-lab-codex.ts';

const dependencyDirectory = process.env.BOITE_BENCH_ALTERNATIVE_DEPS;
if (!dependencyDirectory) throw new Error('Set BOITE_BENCH_ALTERNATIVE_DEPS to the scratch dependency directory.');
const scratch = resolve(dependencyDirectory);
const selectedId = process.env.BOITE_BENCH_TASKS ?? (process.env.BOITE_BENCH_FULL_TASK === '1' ? 'github-issue-investigation' : undefined);
const selectedTask = selectedId ? labTasks.find(task => task.id === selectedId) : undefined;
if (selectedId && !selectedTask) throw new Error('BOITE_BENCH_TASKS must name exactly one manifest task ID.');
const task = selectedTask?.goal ?? 'On https://github.com/microsoft/playwright/issues find CLOSED issues with the browser-chromium label, sort by most comments, open the first issue in that sorted list, and report its title and author. Verify the closed state, label and sort before opening it. Do not sign in or change anything.';
const clean = (_key: string, value: unknown) => typeof value === 'string' && value.startsWith('data:image/') ? { imageBytes: value.length, sha256: createHash('sha256').update(value).digest('hex') } : value;
async function main() {
  if (process.env.BOITE_BENCH_ALTERNATIVES !== '1') throw new Error('Set BOITE_BENCH_ALTERNATIVES=1 for subscription-backed live probes.');
  const mode = process.env.BOITE_BENCH_ALTERNATIVE ?? 'stagehand';
  if (!['stagehand','browser-use'].includes(mode)) throw new Error('Unknown framework.');
  if (mode === 'stagehand' && selectedId && selectedId !== 'github-issue-investigation') throw new Error('Stagehand probe supports only the GitHub issue task.');
  const out = resolve(process.env.BOITE_BENCH_OUTPUT ?? join(scratch,mode+'-'+Date.now())); mkdirSync(out,{recursive:true});
  // Allows an already running sequential batch to select a newer launcher for fresh trials.
  const optionsPath = join(out, 'runtime-options.json');
  const runtimeOptions = existsSync(optionsPath) ? JSON.parse(readFileSync(optionsPath, 'utf8')) : {};
  const browserBinary = runtimeOptions.browserBinary ?? process.env.BOITE_BROWSER_TEST_BINARY;
  if (typeof browserBinary !== 'string' || !existsSync(browserBinary)) throw new Error('Browser binary must name an existing executable.');
  const h=await startTestCore();
  const model = new BrowserLabCodex(h.core, process.env.BOITE_BENCH_CODEX_BINARY!, out);
  let engine: Awaited<ReturnType<typeof createBrowserLabEngine>> | undefined;
  let framework: any, browser: any, server: ReturnType<typeof Bun.serve> | undefined;
  const sample:any={mode,taskId:selectedId,task,rubric:selectedTask?.rubric,startedAt:new Date().toISOString(),cadence:'Fresh ephemeral Codex thread per framework inference. Framework supplies its own prompts, schemas, observations and history.',calls:[],actions:[]};
  let recording:BrowserLabRecording|undefined;let frameworkTarget:string|undefined;
  const timeoutMs=Number(process.env.BOITE_BENCH_TIMEOUT_MS??300_000);
  const start=performance.now();let deadline=Infinity;let callCount=0;let busy=false;
  const generate=async(params:any)=>{
    if(busy) throw new Error('Concurrent model inference rejected.');
    if(++callCount>30 || performance.now()>=deadline) throw new Error('Framework inference budget reached.');
    busy=true;
    try {
      const input:BrowserContentItem[]=[{type:'inputText',text:'Provide the requested browser-framework inference using the supplied observations. No tools are available to you; return the requested JSON decision or extraction for the caller to execute. Reply with only valid JSON matching the requested schema, no markdown or introductory prose. Framework system prompt:\n'+(params.systemPrompt??'')+'\nResponse format:\n'+JSON.stringify(params.responseFormat)}];
      for(const message of params.messages??[]){
        input.push({type:'inputText',text:'Framework message role: '+message.role});
        for(const part of typeof message.content==='string'?[{type:'text',text:message.content}]:Array.isArray(message.content)?message.content:[message.content]){
          if(part?.type==='text') input.push({type:'inputText',text:part.text});
          else if(part?.type==='image') input.push({type:'inputImage',imageUrl:`data:${part.mimeType};base64,${part.data}`});
          else if(part?.type==='image_url') input.push({type:'inputImage',imageUrl:part.image_url.url});
          else if(part) input.push({type:'inputText',text:JSON.stringify(part)});
        }
      }
      const id=String(callCount).padStart(2,'0'),at=performance.now();
      writeFileSync(join(out,'inference-'+id+'-input.json'),JSON.stringify(params,clean,2));
      const result=await model.run(input,[],async()=>{throw new Error('Framework inference cannot call tools');},Math.min(120_000,deadline-performance.now()));
      writeFileSync(join(out,'inference-'+id+'-result.json'),JSON.stringify(result,clean,2));
      const text=result.events.filter((e:any)=>e.method==='item/completed'&&e.params.item.type==='agentMessage').map((e:any)=>e.params.item.text).join('\n');
      const usage=result.events.filter((e:any)=>e.method==='thread/tokenUsage/updated').at(-1)?.params.tokenUsage;
      sample.calls.push({id,ms:performance.now()-at,usage,config:result.config,status:result.turn?.status,images:input.filter(x=>x.type==='inputImage').length});
      writeFileSync(join(out,'progress.json'),JSON.stringify(sample,clean,2));
      if(result.turn?.status!=='completed') throw new Error('Codex inference did not complete.');
      const data=params.responseFormat?.type==='json_schema'?JSON.parse(text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')):undefined;
      return {role:'assistant',content:{type:'text',text},outputFormat:params.responseFormat?.type==='json_schema'?'json_schema':'text',structuredContent:data,text,data};
    } finally {busy=false;}
  };
  try {
    sample.model=await model.initialize();
    // Stagehand's extension opens a CDP WebSocket from chrome-extension origin.
    // Its documented local launcher includes these flags. Apply only to this owned test core launch.
    const originalSpawn = h.core.procs.spawnPiped.bind(h.core.procs);
    if (mode === 'stagehand') h.core.procs.spawnPiped = ((group, executable, args, options) => originalSpawn(group, executable, args, {
      ...options, env: { ...options?.env, AGENT_BROWSER_ARGS: `${options?.env?.AGENT_BROWSER_ARGS ?? ''},--remote-allow-origins=*,--enable-unsafe-extension-debugging` },
    })) as typeof h.core.procs.spawnPiped;
    try { engine=await createBrowserLabEngine('agent-browser',{core:h.core,taskId:'alternative-'+mode,binary:browserBinary,executablePath:findBrowser()}); }
    finally { h.core.procs.spawnPiped = originalSpawn; }
    sample.frameworkBrowserArgs = mode === 'stagehand' ? ['--remote-allow-origins=*','--enable-unsafe-extension-debugging'] : [];
    await engine.command('viewport',{width:1280,height:800});
    await engine.command('navigate',{url:selectedTask?.url ?? 'https://github.com/microsoft/playwright/issues',waitUntil:'domcontentloaded'});
    await engine.command('screenshot',{path:join(out,'initial.png')});
    sample.browser=engine.metadata;sample.startupMs=performance.now()-start;deadline=performance.now()+timeoutMs;
    if(process.env.BOITE_BENCH_FFMPEG){
      const nativeTarget=engine.activeTargetId.bind(engine);
      engine.activeTargetId=async()=>frameworkTarget??nativeTarget();
      recording=await BrowserLabRecording.start(engine,{core:h.core,output:join(out,'browser.mp4'),ffmpegPath:process.env.BOITE_BENCH_FFMPEG,fps:5,width:1280,height:800});
      sample.recorded=true;
    }
    if(mode==='stagehand'){
      const mod=await import(pathToFileURL(join(scratch,'node_modules/@browserbasehq/stagehand/dist/index.mjs')).href);
      browser=await mod.localBrowser.connect({cdpUrl:engine.cdpUrl});
      framework=await mod.Stagehand.create({browser,model:{generate:async (params:any)=>{const {text,data,...result}=await generate(params);return result;}},logging:{level:'warn'}});
      await engine.command('navigate',{url:'https://github.com/microsoft/playwright/issues',waitUntil:'domcontentloaded'});
      const z=await import(pathToFileURL(join(scratch,'node_modules/zod/index.js')).href);
      const phases=[
        {instruction:'Filter the issue list to closed issues with label browser-chromium, and apply the filter.',verify:'Is the issue LIST actually showing CLOSED issues filtered by browser-chromium? Look at the applied page state, not just text entered into an unsubmitted field. Give observed evidence.'},
        {instruction:'Sort the issue results by most comments, keeping the existing closed and browser-chromium filters.',verify:'Is the issue LIST actually sorted by most comments with closed and browser-chromium filters still applied? Give the first result title and the observed evidence for descending comment order.'},
        {instruction:'Open the first issue in the sorted result list.',verify:'Are you now on an individual issue DETAIL page, rather than an issue list? A result row on a list does not count as opening an issue. Give observed evidence from the issue body.'},
      ];
      for(const phase of phases){
        let achieved=false;
        for(let attempt=1;attempt<=2&&!achieved;attempt++){
          const at=performance.now();const result=await framework.act(phase.instruction);
          const verification=await framework.extract(phase.verify,z.z.object({achieved:z.z.boolean(),evidence:z.z.string()}));
          sample.actions.push({instruction:phase.instruction,attempt,result,verification,ms:performance.now()-at});
          await engine.command('screenshot',{path:join(out,'action-'+sample.actions.length+'.png')});
          achieved=verification.data.achieved===true;
          if(!achieved) phase.instruction += ' The previous attempt did not establish completion: '+verification.data.evidence;
        }
        if(!achieved) throw new Error('Stagehand could not verify phase: '+phase.instruction);
      }
      sample.result=await framework.extract('Read the title, author, closed state and labels of the currently open issue.',z.z.object({title:z.z.string(),author:z.z.string(),closed:z.z.boolean(),labels:z.z.array(z.z.string())}));
      sample.metrics=await framework.metrics();
    } else {
      const token=randomUUID();
      server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:0,fetch:async req=>{
        if(req.headers.get('authorization')!=='Bearer '+token) return new Response('Denied',{status:403});
        try {const body:any=await req.json();if(new URL(req.url).pathname==='/record'){if(typeof body.targetId==='string'){frameworkTarget=body.targetId;await recording?.follow();}return Response.json({ok:true});}return Response.json(await generate(body));} catch(error){return Response.json({error:String(error)},{status:500});}
      }});
      const env:Record<string,string>={};for(const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[key])env[key]=process.env[key]!;
      Object.assign(env,{BENCH_BRIDGE_URL:`http://127.0.0.1:${server.port}`,BENCH_BRIDGE_TOKEN:token,BENCH_CDP_URL:engine.cdpUrl,BENCH_OUTPUT:out,BENCH_TASK:task,BENCH_HOSTS:JSON.stringify(selectedTask?.hosts ?? ['github.com']),BROWSER_USE_CONFIG_DIR:join(out,'browser-use-config'),BENCH_TIMEOUT_MS:String(timeoutMs),ANONYMIZED_TELEMETRY:'false',BROWSER_USE_LOGGING_LEVEL:'info',PYTHONIOENCODING:'utf-8'});
      const child=h.core.procs.spawnChild('framework-browser-use',join(scratch,'.venv/Scripts/python.exe'),[join(import.meta.dir,'browser-lab-alternatives.py')],{cwd:out,env});
      let stdout='',stderr='';child.stdout.on('data',c=>stdout+=c);child.stderr.on('data',c=>stderr+=c);
      const timer=setTimeout(()=>h.core.procs.killTree('framework-browser-use'),timeoutMs+30_000);
      try {sample.exitCode=await new Promise(resolve=>child.once('close',resolve));}finally{clearTimeout(timer);writeFileSync(join(out,'python.stdout.log'),stdout);writeFileSync(join(out,'python.stderr.log'),stderr);await h.core.procs.stopAndWait('framework-browser-use');}
    }
  }catch(error){sample.error=error instanceof Error?error.stack:String(error);}
  finally{
    sample.totalMs=performance.now()-start;
    if(engine)try{sample.tabs=await engine.command('tabs');sample.final=await engine.command('evaluate',{script:'JSON.stringify({url:location.href,title:document.title,text:document.body.innerText,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},prefersDark:matchMedia("(prefers-color-scheme: dark)").matches})'});await engine.command('screenshot',{path:join(out,'final.png')});}catch(error){sample.captureError=String(error);}
    if(recording)try{sample.recording=await recording.stop();}catch(error){sample.recordingError=String(error);}
    try{await framework?.close();await browser?.close();}catch(error){sample.frameworkCloseError=String(error);}
    await engine?.close();await model.close();server?.stop(true);sample.processesAfter=h.core.procs.liveCount(model.processKey) + h.core.procs.liveCount(`browser:alternative-${mode}`) + h.core.procs.liveCount('framework-browser-use') + (recording ? h.core.procs.liveCount(recording.processGroup) : 0);await h.stop();
    writeFileSync(join(out,'summary.json'),JSON.stringify(sample,clean,2));console.log(JSON.stringify({mode,out,error:sample.error,calls:sample.calls.length,totalMs:sample.totalMs,processesAfter:sample.processesAfter}));
  }
}
await main();
