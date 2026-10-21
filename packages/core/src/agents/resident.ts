import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgentAccountGrant, AgentBrain, AgentBrainRoot, AgentProfile, AgentRuntimeConfig, AgentScope, AgentSelection, AgentWork, RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { agentProvider, checkEffort, checkModel } from '../threads/selection.ts';
import { ids, integer, object, text } from './validation.ts';
import { OPEN_WORK } from './repository.ts';
import { withLoad } from '../threads/records.ts';
import { slugOf } from '../worktree.ts';

const BRAIN_ROOT = 'agents:brain-root';
const BRAIN_DIR = 'agents:brain-dir:';
/** What a new agent's brain starts with. */
const BRAIN_FILES: Record<string, string> = {
  'AGENTS.md': '# Individual brain\n\nKeep reusable procedures in skills/. Use scoped memory for group and mission findings.\n',
  'MEMORY.md': '',
};
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export const sameRoute = (a: Pick<AgentSelection,'providerId'|'accountId'|'model'>, b: Pick<AgentSelection,'providerId'|'accountId'|'model'>) => a.providerId === b.providerId && a.accountId === b.accountId && a.model === b.model;

/** Identity-owned configuration. Provider sessions and browser clients may come and go. */
export class ResidentAgents {
  constructor(private readonly core: Core) {}
  private get records() { return this.core.workforce.records; }
  config(agentId: string): AgentRuntimeConfig {
    const agent = this.records.get('profile',agentId);
    const saved = this.core.journal.getSetting(`agents:runtime:${agentId}`) as AgentRuntimeConfig | undefined;
    if (saved) return { ...saved, defaultRoute: agent.selection };
    const model = agent.selection.model ?? agentProvider(this.core, agent).models.find(m => m.default)?.id ?? agentProvider(this.core, agent).models[0]?.id;
    if (!model) throw refused('default model: choose a model for this agent');
    // Subagents are on by default: an agent splits its work the way a thread does, on any granted model.
    return { defaultRoute:{...agent.selection,model}, allowedRoutes:[{...agent.selection,model,id:'default',name:'Default'}], subagents:{enabled:true,paused:false,profiles:[],anyModel:true}, compactAfterTurns:12,maxRunMinutes:10,autoMemory:true };
  }
  grants(): AgentAccountGrant[] { return (this.core.journal.getSetting('agents:account-grants') as AgentAccountGrant[] | undefined) ?? []; }
  accountAllowed(agentId: string, accountId: string): boolean { const grant=this.grants().find(g=>g.accountId===accountId); return !grant || grant.agentIds===null || grant.agentIds.includes(agentId); }
  /**
   * A main route must be one of the allowed routes. A child runs on a listed
   * subagent profile; with none listed it runs on any model of a granted
   * account, unless the owner turned free model choice off.
   */
  allowed(agentId: string, selection: AgentSelection, child=false): boolean {
    const config=this.config(agentId);
    if(!this.accountAllowed(agentId,selection.accountId))return false;
    if(child&&config.subagents.profiles.length===0)return config.subagents.anyModel!==false;
    return (child ? config.subagents.profiles : config.allowedRoutes).some(p=>sameRoute(p,{...selection,model:selection.model??config.defaultRoute.model}));
  }
  route(agentId: string, value: AgentSelection): AgentSelection {
    object(value,'route');
    const provider=this.core.providers.require(text(value.providerId,'route.providerId',100));
    const account=this.core.accounts.require(text(value.accountId,'route.accountId',160));
    if(account.providerId!==provider.id || !this.accountAllowed(agentId,account.id))throw refused('route.accountId: account is not granted to this agent');
    const model=text(value.model,'route.model',256);
    checkModel(provider,account.id,model);
    return {...value,model,effort:checkEffort(provider,account.id,model,value.effort)};
  }
  configure(params: RpcParams<'agents.runtime.configure'>): AgentProfile {
    const agent=this.records.get('profile',params.agentId), v=params.config;
    object(v,'config');
    const selection=this.route(agent.id,v.defaultRoute);
    if(!Array.isArray(v.allowedRoutes)||v.allowedRoutes.length>32)throw refused('allowedRoutes: expected at most 32 routes');
    const routes=v.allowedRoutes.map(p=>({...this.route(agent.id,{...p,permissionMode:selection.permissionMode}),id:text(p.id,'route.id',64),name:text(p.name,'route.name',100),model:p.model}));
    if(!routes.some(r=>sameRoute(r,selection)))throw refused('defaultRoute: default model must be in allowedRoutes');
    if(new Set(routes.map(r=>r.id)).size!==routes.length)throw refused('allowedRoutes: route ids must be unique');
    const subagents=this.core.delegation.validateConfig(v.subagents);
    for(const p of subagents.profiles)this.route(agent.id,{...p,permissionMode:selection.permissionMode});
    if(v.autoMemory!==undefined&&typeof v.autoMemory!=='boolean')throw refused('autoMemory: expected true or false');
    const config:AgentRuntimeConfig={defaultRoute:selection,allowedRoutes:routes,subagents,compactAfterTurns:integer(v.compactAfterTurns,'compactAfterTurns',2,100),maxRunMinutes:integer(v.maxRunMinutes,'maxRunMinutes',1,120),autoMemory:v.autoMemory!==false};
    const saved=this.records.transaction(()=>{
      // saveProfile validates the permission mode. Persist policy first in the same transaction.
      this.core.journal.setSetting(`agents:runtime:${agent.id}`,config);
      return this.core.workforce.saveProfile({id:agent.id,expectedRevision:params.expectedRevision,value:{...agent,selection}});
    });
    this.enforce();
    // An archived session keeps its old config; delegation.configure refuses it after the commit above.
    for(const session of this.records.list('session').filter(s=>s.agentId===agent.id&&this.core.journal.getThread(s.threadId)?.archived===false))this.core.delegation.configure(session.threadId,config.subagents);
    this.core.workforce.changed();return saved;
  }
  setGrants(grants: AgentAccountGrant[]): AgentAccountGrant[] {
    if(!Array.isArray(grants)||grants.length>200)throw refused('grants: expected at most 200 account grants');
    const checked=grants.map(g=>{object(g,'grant');const account=this.core.accounts.require(text(g.accountId,'accountId',160));const agentIds=g.agentIds===null?null:ids(g.agentIds,'agentIds');for(const id of agentIds??[])this.records.get('profile',id);return{accountId:account.id,agentIds};});
    if(new Set(checked.map(g=>g.accountId)).size!==checked.length)throw refused('grants: account ids must be unique');
    this.core.journal.append({type:'agents.limits',threadId:null,version:1,payload:{grants:checked}},()=>this.core.journal.setSetting('agents:account-grants',checked));
    this.enforce();this.core.workforce.changed();return checked;
  }
  ownerOf(threadId: string): string | null {
    const thread=this.core.journal.getThread(threadId);
    if(!thread)return null;
    const root=thread.parentThreadId?this.core.journal.getThread(thread.parentThreadId):thread;
    if(!root?.agentSessionId)return null;
    return this.records.get('session',root.agentSessionId).agentId;
  }
  assertThreadRoute(threadId:string, selection:AgentSelection):void {
    const owner=this.ownerOf(threadId);if(!owner)return;
    if(this.records.get('profile',owner).status!=='active'||!this.allowed(owner,selection,!!this.core.threads.require(threadId).parentThreadId))throw refused('account/model access was withdrawn from this agent');
  }
  isCompacting(threadId: string): boolean {
    if (!this.core.journal.getThread(threadId)?.agentSessionId) return false;
    return this.records.withStatus('run', ['accepted', 'running']).some(run => run.threadId === threadId && this.records.get('work', run.workId).purpose === 'compaction');
  }
  enforce():void {
    for(const run of this.records.withStatus('run',['accepted','running'])) {
      const status=this.records.get('profile',run.agentId).status;
      if(status==='active'&&this.allowed(run.agentId,run.execution))continue;
      // The card says what the owner did: a paused or archived agent is not a withdrawn route.
      const error=status==='paused'?'The agent was paused. Resume it to continue.':status==='archived'?'The agent was archived.':'Model or account access withdrawn. Review before resuming.';
      const work=this.records.get('work',run.workId);
      if(work.status==='running')this.records.update('work',work.id,work.revision,{...work,status:'paused',error});
      this.core.threads.stopTurn(run.threadId);
    }
    for(const thread of this.core.journal.listThreads()){
      const owner=this.ownerOf(thread.id);if(!owner||!thread.parentThreadId)continue;
      if(!this.allowed(owner,thread,true)||this.records.get('profile',owner).status!=='active')this.core.delegation.stop(thread.id,undefined,'owner');
    }
  }
  /** Where brains live: the folder the owner chose, else the core's data directory. */
  brainRoot():AgentBrainRoot {
    const custom=this.core.journal.getSetting(BRAIN_ROOT) as string|undefined;
    return custom?{path:custom,custom:true}:{path:join(this.core.dataDir,'agent-workspaces'),custom:false};
  }
  /** A folder name under `root` for the agent: its name, numbered past `used` names and folders that already hold files. */
  private folderFor(agentId:string, root:string, used:Set<string>):string {
    const base=slugOf(this.records.get('profile',agentId).name).replace(/^thread$/,'agent');
    let folder=base;
    for(let n=2;used.has(folder)||existsSync(join(root,folder))&&readdirSync(join(root,folder)).length>0;n++)folder=`${base}-${n}`;
    return folder;
  }
  /**
   * An agent's brain folder. The default keeps the historical
   * `agent-workspaces/<id>/brain`; a chosen root holds one folder per agent,
   * named after it the first time it lands there and kept through renames.
   */
  brainPath(agentId:string, root:AgentBrainRoot=this.brainRoot()):string {
    if(!root.custom)return join(root.path,agentId,'brain');
    const saved=this.core.journal.getSetting(`${BRAIN_DIR}${agentId}`) as string|undefined;
    if(saved)return join(root.path,saved);
    const used=new Set(this.records.list('profile').filter(p=>p.id!==agentId).flatMap(p=>{const d=this.core.journal.getSetting(`${BRAIN_DIR}${p.id}`) as string|undefined;return d?[d]:[];}));
    const folder=this.folderFor(agentId,root.path,used);
    this.core.journal.setSetting(`${BRAIN_DIR}${agentId}`,folder);
    return join(root.path,folder);
  }
  brain(agentId:string):AgentBrain {
    this.records.get('profile',agentId);
    const path=this.brainPath(agentId);
    mkdirSync(join(path,'skills'),{recursive:true});
    for(const [name,content] of Object.entries(BRAIN_FILES))if(!existsSync(join(path,name)))writeFileSync(join(path,name),content,{flag:'wx'});
    const instructions=readFileSync(join(path,'AGENTS.md'),'utf8'),memory=readFileSync(join(path,'MEMORY.md'),'utf8');
    const revision=createHash('sha256').update(JSON.stringify([instructions,memory])).digest('hex');
    return{path,instructions,memory,revision};
  }
  /**
   * Move every brain under a new root, or back to the default with null. A
   * destination that already holds files refuses the whole change before
   * anything moves; so does an agent at work, whose prompt names its folder.
   */
  setBrainRoot(value:string|null):AgentBrainRoot {
    let root:AgentBrainRoot;
    if(value===null)root={path:join(this.core.dataDir,'agent-workspaces'),custom:false};
    else {
      const raw=text(value,'path',4096);
      if(!isAbsolute(raw))throw refused(`path: expected an absolute folder, got ${raw}`);
      try{mkdirSync(raw,{recursive:true});}catch(error){throw refused(`path: cannot create ${raw}: ${(error as Error).message}`);}
      const path=realpathSync(raw);
      if(!statSync(path).isDirectory())throw refused(`path: ${path} is not a folder`);
      const data=realpathSync(this.core.dataDir),fallback=join(data,'agent-workspaces');
      if(path!==fallback&&(inside(data,path)||inside(path,data)))throw refused(`path: ${path} holds the core's own data; choose a folder of its own`);
      root=path===fallback?{path:join(this.core.dataDir,'agent-workspaces'),custom:false}:{path,custom:true};
    }
    if(this.records.withStatus('run',['accepted','running']).length||this.core.workforce.memory.busy())throw refused('agents are at work; move their brains once they finish');
    const current=this.brainRoot();
    if(current.path===root.path&&current.custom===root.custom)return root;
    // A new root names its folders afresh, and nothing is written until every destination checked out.
    const used=new Set<string>();
    const plan=this.records.list('profile').map(agent=>{
      const from=this.brainPath(agent.id,current);
      if(!root.custom)return{agent,from,to:join(root.path,agent.id,'brain'),folder:null};
      const folder=this.folderFor(agent.id,root.path,used);used.add(folder);
      return{agent,from,to:join(root.path,folder),folder};
    });
    const moves=plan.filter(m=>m.from!==m.to&&existsSync(m.from));
    for(const {to} of moves)if(existsSync(to)&&readdirSync(to).length>0)throw refused(`path: ${to} already holds files; empty it or choose another folder`);
    const move=(from:string,to:string)=>{
      mkdirSync(join(to,'..'),{recursive:true});
      if(existsSync(to))rmdirSync(to);
      try{renameSync(from,to);}
      catch(error){
        if((error as NodeJS.ErrnoException).code!=='EXDEV')throw error;
        cpSync(from,to,{recursive:true,errorOnExist:true});rmSync(from,{recursive:true,force:true});
      }
    };
    const done:{from:string;to:string}[]=[];
    try{for(const m of moves){move(m.from,m.to);done.push(m);}}
    catch(error){
      // Put back what moved, so every brain stays where the settings say it is.
      for(const m of done.reverse()){try{move(m.to,m.from);}catch(back){this.core.log('error',`Brain ${m.to} could not move back to ${m.from}: ${(back as Error).message}`);}}
      throw refused(`path: moving the brains failed and was undone: ${(error as Error).message}`);
    }
    for(const {agent,folder} of plan){if(folder)this.core.journal.setSetting(`${BRAIN_DIR}${agent.id}`,folder);else this.core.journal.deleteSetting(`${BRAIN_DIR}${agent.id}`);}
    if(root.custom)this.core.journal.setSetting(BRAIN_ROOT,root.path);else this.core.journal.deleteSetting(BRAIN_ROOT);
    this.core.log('info',`Agent brains now live under ${root.path}; ${moves.length} moved`);
    this.core.workforce.changed();
    return root;
  }
  saveBrain(p:RpcParams<'agents.brain.save'>):AgentBrain {
    const brain=this.brain(p.agentId);
    if(brain.revision!==p.expectedRevision)throw refused('brain revision changed; reload before saving');
    const instructions=text(p.instructions,'instructions',32000,true),memory=text(p.memory,'memory',64000,true);
    for(const [name,content] of [['AGENTS.md',instructions],['MEMORY.md',memory]]){const target=join(brain.path,name!);writeFileSync(target+'.tmp',content!);renameSync(target+'.tmp',target);}
    this.core.workforce.changed();return this.brain(p.agentId);
  }
  enqueue(agentId:string,prompt:string,scope:AgentScope={kind:'agent',id:agentId},episodeId:string=crypto.randomUUID()):AgentWork {
    return this.records.create('work',{agentId,scope,taskId:null,taskGeneration:null,messageId:null,episodeId,prompt,status:'pending',error:null,runId:null,notBefore:Date.now()});
  }
  compact(sessionId:string,requestId:string):AgentWork {
    const session=this.records.get('session',sessionId);
    return this.records.command(`compact:${sessionId}`,requestId,{sessionId},()=>{
      if(this.records.withStatus('work',OPEN_WORK).some(w=>w.agentId===session.agentId&&w.scope.kind===session.scope.kind&&w.scope.id===session.scope.id&&w.purpose==='compaction'))throw refused('compaction already unfinished');
      const work=this.records.create('work',{agentId:session.agentId,scope:session.scope,taskId:null,taskGeneration:null,messageId:null,episodeId:crypto.randomUUID(),purpose:'compaction',prompt:'Create a compact continuation note for THIS context only. Preserve the objective, decisions, unfinished tasks, paths, verification evidence and unresolved questions. Distinguish completed actions from proposed actions. Do not execute tools or continue the task. Return only the note, at most 6000 characters. This note will replace the native conversation context, not durable memory.',status:'pending',error:null,runId:null,notBefore:Date.now()});
      this.core.workforce.changed();return work;
    });
  }
  checkpoint(threadId:string,work:AgentWork,result:string):void {
    if(!result.trim())throw refused('compaction returned no continuation note; existing context retained');
    const session=this.core.workforce.session(threadId);
    this.core.journal.setSetting(`agents:checkpoint:${session.id}`,{text:result.slice(0,12000),at:Date.now(),workId:work.id});
    const thread=this.core.threads.require(threadId);
    this.core.threads.releaseAgent(threadId);
    // The explicit checkpoint replaces history. Keep the journal for inspection, without replaying it.
    const next={...thread,sessionId:null,sessionGeneration:(thread.sessionGeneration ?? 0)+1,context:null,promptCache:null};
    this.core.journal.putThread(next);this.core.bus.emit('thread.updated',withLoad(this.core,next));
  }
}
