import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { AGENT_DAILY_BUDGET } from '@boite/contracts';
import type { AgentAccountGrant, AgentBrain, AgentBrainRoot, AgentProfile, AgentRuntimeConfig, AgentSelection, RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { agentProvider, checkSavedSelection } from '../threads/selection.ts';
import { checkBrainPath, createBrainFile, readBrainFile, rewriteBrainFile } from './brain-files.ts';
import { ids, object, text } from './validation.ts';
import type { AgentsRepository } from './repository.ts';
import { slugOf } from '../worktree.ts';

const BRAIN_ROOT = 'agents:brain-root';
const BRAIN_DIR = 'agents:brain-dir:';
/** What a new agent's brain starts with. */
const BRAIN_FILES: Record<string, string> = {
  'AGENTS.md': '# Individual brain\n\nKeep reusable procedures in skills/. Durable facts go to MEMORY.md through boite bot remember.\n',
  'MEMORY.md': '',
};
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };

export const sameRoute = (a: Pick<AgentSelection,'providerId'|'accountId'|'model'>, b: Pick<AgentSelection,'providerId'|'accountId'|'model'>) => a.providerId === b.providerId && a.accountId === b.accountId && a.model === b.model;

/** Identity-owned configuration. Provider sessions and browser clients may come and go. */
export class ResidentAgents {
  readonly #core: Core;
  readonly #records: AgentsRepository;

  constructor(core: Core, records: AgentsRepository) {
    this.#core = core;
    this.#records = records;}
  config(agentId: string): AgentRuntimeConfig {
    const agent = this.#records.get('profile',agentId);
    // Configurations saved by older cores also hold `compactAfterTurns` and `maxRunMinutes`: nothing reads them.
    const saved = this.#core.journal.getSetting(`agents:runtime:${agentId}`) as (AgentRuntimeConfig & Record<string, unknown>) | undefined;
    if (saved) return { defaultRoute: agent.selection, allowedRoutes: saved.allowedRoutes, subagents: saved.subagents, autoMemory: saved.autoMemory !== false, eventWakes: saved.eventWakes === true, dailyBudgetUsd: saved.dailyBudgetUsd ?? null };
    const model = agent.selection.model ?? agentProvider(this.#core, agent).models.find(m => m.default)?.id ?? agentProvider(this.#core, agent).models[0]?.id;
    if (!model) throw refused('default model: choose a model for this bot');
    // Subagents are on by default: an agent splits its work the way a thread does, on any granted model.
    return { defaultRoute:{...agent.selection,model}, allowedRoutes:[{...agent.selection,model,id:'default',name:'Default'}], subagents:{enabled:true,paused:false,profiles:[],anyModel:true}, autoMemory:true, eventWakes:false, dailyBudgetUsd:null };
  }
  grants(): AgentAccountGrant[] { return (this.#core.journal.getSetting('agents:account-grants') as AgentAccountGrant[] | undefined) ?? []; }
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
  route(agentId: string, value: AgentSelection, previous?: Pick<AgentSelection, 'providerId' | 'accountId' | 'model' | 'effort'>): AgentSelection {
    object(value,'route');
    const provider=this.#core.providers.require(text(value.providerId,'route.providerId',100));
    const account=this.#core.accounts.require(text(value.accountId,'route.accountId',160));
    if(account.providerId!==provider.id || !this.accountAllowed(agentId,account.id))throw refused('route.accountId: account is not granted to this bot');
    const model=text(value.model,'route.model',256);
    checkSavedSelection(provider,account.id,{...value,model},previous);
    return {...value,model};
  }
  configure(params: RpcParams<'agents.runtime.configure'>): AgentProfile {
    const agent=this.#records.get('profile',params.agentId), v=params.config;
    object(v,'config');
    const previous=this.config(agent.id);
    const selection=this.route(agent.id,v.defaultRoute,agent.selection);
    if(!Array.isArray(v.allowedRoutes)||v.allowedRoutes.length>32)throw refused('allowedRoutes: expected at most 32 routes');
    const routes=v.allowedRoutes.map(p=>({...this.route(agent.id,{...p,permissionMode:selection.permissionMode},previous.allowedRoutes.find(r=>r.id===p.id)),id:text(p.id,'route.id',64),name:text(p.name,'route.name',100),model:p.model}));
    if(!routes.some(r=>sameRoute(r,selection)))throw refused('defaultRoute: default model must be in allowedRoutes');
    if(new Set(routes.map(r=>r.id)).size!==routes.length)throw refused('allowedRoutes: route ids must be unique');
    const subagents=this.#core.delegation.validateConfig(v.subagents,previous.subagents);
    for(const p of subagents.profiles)this.route(agent.id,{...p,permissionMode:selection.permissionMode},previous.subagents.profiles.find(r=>r.id===p.id));
    if(v.autoMemory!==undefined&&typeof v.autoMemory!=='boolean')throw refused('autoMemory: expected true or false');
    if(v.eventWakes!==undefined&&typeof v.eventWakes!=='boolean')throw refused('eventWakes: expected true or false');
    const budget=v.dailyBudgetUsd??null;
    if(budget!==null&&(typeof budget!=='number'||!Number.isFinite(budget)||budget<AGENT_DAILY_BUDGET.min||budget>AGENT_DAILY_BUDGET.max))throw refused(`dailyBudgetUsd: expected dollars a day from ${AGENT_DAILY_BUDGET.min} to ${AGENT_DAILY_BUDGET.max}, or null for no cap`,{field:'dailyBudgetUsd'});
    const config:AgentRuntimeConfig={defaultRoute:selection,allowedRoutes:routes,subagents,autoMemory:v.autoMemory!==false,eventWakes:v.eventWakes??previous.eventWakes??false,dailyBudgetUsd:budget===null?null:Math.round(budget*100)/100};
    const saved=this.#records.transaction(()=>{
      // saveProfile validates the permission mode. Persist policy first in the same transaction.
      this.#core.journal.setSetting(`agents:runtime:${agent.id}`,config);
      return this.#core.workforce.saveProfile({id:agent.id,expectedRevision:params.expectedRevision,value:{...agent,selection}});
    });
    this.enforce();
    // An archived thread keeps its old config; delegation.configure refuses it after the commit above.
    for(const session of this.#records.list('session').filter(s=>s.agentId===agent.id&&this.#core.journal.getThread(s.threadId)?.archived===false))this.#core.delegation.configure(session.threadId,config.subagents);
    this.#core.workforce.changed();return saved;
  }
  setGrants(grants: AgentAccountGrant[]): AgentAccountGrant[] {
    if(!Array.isArray(grants)||grants.length>200)throw refused('grants: expected at most 200 account grants');
    const checked=grants.map(g=>{object(g,'grant');const account=this.#core.accounts.require(text(g.accountId,'accountId',160));const agentIds=g.agentIds===null?null:ids(g.agentIds,'agentIds');for(const id of agentIds??[])this.#records.get('profile',id);return{accountId:account.id,agentIds};});
    if(new Set(checked.map(g=>g.accountId)).size!==checked.length)throw refused('grants: account ids must be unique');
    this.#core.journal.append({type:'agents.limits',threadId:null,version:1,payload:{grants:checked}},()=>this.#core.journal.setSetting('agents:account-grants',checked));
    this.enforce();this.#core.workforce.changed();return checked;
  }
  /** The agent whose thread this is, or whose thread is this subagent's parent. */
  ownerOf(threadId: string): string | null {
    const thread=this.#core.journal.getThread(threadId);
    if(!thread)return null;
    const root=thread.parentThreadId?this.#core.journal.getThread(thread.parentThreadId):thread;
    if(!root?.agentSessionId)return null;
    return this.#records.sessionOfThread(root.id)?.agentId??null;
  }
  /**
   * An agent's turns and its subagents' run on routes its policy allows. A
   * paused agent still answers the user; only its wakes wait.
   */
  assertThreadRoute(threadId:string, selection:AgentSelection):void {
    const owner=this.ownerOf(threadId);if(!owner)return;
    if(this.#records.get('profile',owner).status==='archived'||!this.allowed(owner,selection,!!this.#core.threads.require(threadId).parentThreadId))throw refused('account/model access was withdrawn from this bot');
  }
  /** Stops what runs on a route the owner withdrew, and the subagents of an archived agent. */
  enforce():void {
    for(const session of this.#records.list('session')){
      const thread=this.#core.journal.getThread(session.threadId);
      if(!thread||!['running','queued','waiting'].includes(thread.status))continue;
      const status=this.#records.find('profile',session.agentId)?.status;
      if(status!=='archived'&&this.allowed(session.agentId,thread))continue;
      this.#core.threads.stopTurn(thread.id);
    }
    for(const thread of this.#core.journal.listChildThreads()){
      const owner=this.ownerOf(thread.id);if(!owner)continue;
      if(!this.allowed(owner,thread,true)||this.#records.get('profile',owner).status==='archived')this.#core.delegation.stop(thread.id,undefined,'owner');
    }
  }
  /** Where brains live: the folder the owner chose, else the core's data directory. */
  brainRoot():AgentBrainRoot {
    const custom=this.#core.journal.getSetting(BRAIN_ROOT) as string|undefined;
    return custom?{path:custom,custom:true}:{path:join(this.#core.dataDir,'agent-workspaces'),custom:false};
  }
  /** A folder name under `root` for the agent: its name, numbered past `used` names and folders that already hold files. */
  #folderFor(agentId:string, root:string, used:Set<string>):string {
    const base=slugOf(this.#records.get('profile',agentId).name).replace(/^thread$/,'agent');
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
    const saved=this.#core.journal.getSetting(`${BRAIN_DIR}${agentId}`) as string|undefined;
    if(saved)return join(root.path,saved);
    const used=new Set(this.#records.list('profile').filter(p=>p.id!==agentId).flatMap(p=>{const d=this.#core.journal.getSetting(`${BRAIN_DIR}${p.id}`) as string|undefined;return d?[d]:[];}));
    const folder=this.#folderFor(agentId,root.path,used);
    this.#core.journal.setSetting(`${BRAIN_DIR}${agentId}`,folder);
    return join(root.path,folder);
  }
  brain(agentId:string):AgentBrain {
    this.#records.get('profile',agentId);
    const root=this.brainRoot().path,path=this.brainPath(agentId);
    // A linked folder is refused before anything is created through it (`brain-files.ts`).
    checkBrainPath(root,join(path,'skills'),true);
    mkdirSync(join(path,'skills'),{recursive:true});
    for(const [name,content] of Object.entries(BRAIN_FILES)){
      try{createBrainFile(root,join(path,name),content);}
      catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    }
    const instructions=readBrainFile(root,join(path,'AGENTS.md')),memory=readBrainFile(root,join(path,'MEMORY.md'));
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
    if(value===null)root={path:join(this.#core.dataDir,'agent-workspaces'),custom:false};
    else {
      const raw=text(value,'path',4096);
      if(!isAbsolute(raw))throw refused(`path: expected an absolute folder, got ${raw}`);
      try{mkdirSync(raw,{recursive:true});}catch(error){throw refused(`path: cannot create ${raw}: ${(error as Error).message}`);}
      const path=realpathSync(raw);
      if(!statSync(path).isDirectory())throw refused(`path: ${path} is not a folder`);
      const data=realpathSync(this.#core.dataDir),fallback=join(data,'agent-workspaces');
      if(path!==fallback&&(inside(data,path)||inside(path,data)))throw refused(`path: ${path} holds the core's own data; choose a folder of its own`);
      root=path===fallback?{path:join(this.#core.dataDir,'agent-workspaces'),custom:false}:{path,custom:true};
    }
    if(this.#records.list('session').some(s=>['running','queued','waiting'].includes(this.#core.journal.getThread(s.threadId)?.status??'idle'))||this.#core.workforce.memory.busy())throw refused('agents are at work; move their brains once they finish');
    const current=this.brainRoot();
    if(current.path===root.path&&current.custom===root.custom)return root;
    // A new root names its folders afresh, and nothing is written until every destination checked out.
    const used=new Set<string>();
    const plan=this.#records.list('profile').map(agent=>{
      const from=this.brainPath(agent.id,current);
      if(!root.custom)return{agent,from,to:join(root.path,agent.id,'brain'),folder:null};
      const folder=this.#folderFor(agent.id,root.path,used);used.add(folder);
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
      for(const m of done.reverse()){try{move(m.to,m.from);}catch(back){this.#core.log('error',`Brain ${m.to} could not move back to ${m.from}: ${(back as Error).message}`);}}
      throw refused(`path: moving the brains failed and was undone: ${(error as Error).message}`);
    }
    for(const {agent,folder} of plan){if(folder)this.#core.journal.setSetting(`${BRAIN_DIR}${agent.id}`,folder);else this.#core.journal.deleteSetting(`${BRAIN_DIR}${agent.id}`);}
    if(root.custom)this.#core.journal.setSetting(BRAIN_ROOT,root.path);else this.#core.journal.deleteSetting(BRAIN_ROOT);
    this.#core.log('info',`Agent brains now live under ${root.path}; ${moves.length} moved`);
    this.#core.workforce.changed();
    return root;
  }
  saveBrain(p:RpcParams<'agents.brain.save'>):AgentBrain {
    const brain=this.brain(p.agentId);
    if(brain.revision!==p.expectedRevision)throw refused('brain revision changed; reload before saving');
    // An older MEMORY.md may run past AGENT_MEMORY_MAX: the owner can still save it while cutting it down.
    const instructions=text(p.instructions,'instructions',32000,true),memory=text(p.memory,'memory',64000,true);
    for(const [name,content] of [['AGENTS.md',instructions],['MEMORY.md',memory]])rewriteBrainFile(this.brainRoot().path,join(brain.path,name!),content!);
    this.#core.workforce.changed();return this.brain(p.agentId);
  }
}
