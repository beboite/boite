import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DELEGATION_CONFIG } from '@boite/contracts';
import type { AgentAccountGrant, AgentBrain, AgentProfile, AgentRuntimeConfig, AgentScope, AgentSelection, AgentWork, RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { refused } from '../errors.ts';
import { checkEffort, checkModel } from '../threads.ts';
import { ids, integer, object, text } from './validation.ts';
import { releaseThread } from '../drivers/index.ts';

export const sameRoute = (a: Pick<AgentSelection,'providerId'|'accountId'|'model'>, b: Pick<AgentSelection,'providerId'|'accountId'|'model'>) => a.providerId === b.providerId && a.accountId === b.accountId && a.model === b.model;

/** Identity-owned configuration. Provider sessions and browser clients may come and go. */
export class ResidentAgents {
  constructor(private readonly core: Core) {}
  private get records() { return this.core.workforce.records; }
  config(agentId: string): AgentRuntimeConfig {
    const agent = this.records.get('profile',agentId);
    const saved = this.core.journal.getSetting(`agents:runtime:${agentId}`) as AgentRuntimeConfig | undefined;
    if (saved) return { ...saved, defaultRoute: agent.selection };
    const model = agent.selection.model ?? this.core.providers.require(agent.selection.providerId).models.find(m => m.default)?.id ?? this.core.providers.require(agent.selection.providerId).models[0]?.id;
    if (!model) throw refused('default model: choose a model for this agent');
    return { defaultRoute:{...agent.selection,model}, allowedRoutes:[{...agent.selection,model,id:'default',name:'Default'}], subagents:structuredClone(DEFAULT_DELEGATION_CONFIG), compactAfterTurns:12,maxRunMinutes:10 };
  }
  grants(): AgentAccountGrant[] { return (this.core.journal.getSetting('agents:account-grants') as AgentAccountGrant[] | undefined) ?? []; }
  accountAllowed(agentId: string, accountId: string): boolean { const grant=this.grants().find(g=>g.accountId===accountId); return !grant || grant.agentIds===null || grant.agentIds.includes(agentId); }
  allowed(agentId: string, selection: AgentSelection, child=false): boolean {
    const config=this.config(agentId);
    return this.accountAllowed(agentId,selection.accountId) && (child ? config.subagents.profiles : config.allowedRoutes).some(p=>sameRoute(p,{...selection,model:selection.model??config.defaultRoute.model}));
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
    const config:AgentRuntimeConfig={defaultRoute:selection,allowedRoutes:routes,subagents,compactAfterTurns:integer(v.compactAfterTurns,'compactAfterTurns',2,100),maxRunMinutes:integer(v.maxRunMinutes,'maxRunMinutes',1,120)};
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
      if(this.records.get('profile',run.agentId).status==='active'&&this.allowed(run.agentId,run.execution))continue;
      const work=this.records.get('work',run.workId);
      if(work.status==='running')this.records.update('work',work.id,work.revision,{...work,status:'paused',error:'Model or account access withdrawn. Review before resuming.'});
      this.core.threads.stopTurn(run.threadId);
    }
    for(const thread of this.core.journal.listThreads()){
      const owner=this.ownerOf(thread.id);if(!owner||!thread.parentThreadId)continue;
      if(!this.allowed(owner,thread,true)||this.records.get('profile',owner).status!=='active')this.core.delegation.stop(thread.id);
    }
  }
  brain(agentId:string):AgentBrain {
    this.records.get('profile',agentId);
    const path=join(this.core.dataDir,'agent-workspaces',agentId,'brain');
    mkdirSync(join(path,'skills'),{recursive:true});
    const initial:Record<string,string>={'AGENTS.md':'# Individual brain\n\nKeep reusable procedures in skills/. Use scoped memory for group and mission findings.\n','MEMORY.md':''};
    for(const [name,content] of Object.entries(initial))if(!existsSync(join(path,name)))writeFileSync(join(path,name),content,{flag:'wx'});
    const instructions=readFileSync(join(path,'AGENTS.md'),'utf8'),memory=readFileSync(join(path,'MEMORY.md'),'utf8');
    const revision=createHash('sha256').update(JSON.stringify([instructions,memory])).digest('hex');
    return{path,instructions,memory,revision};
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
      if(this.records.list('work').some(w=>w.agentId===session.agentId&&w.scope.kind===session.scope.kind&&w.scope.id===session.scope.id&&w.purpose==='compaction'&&!['done','cancelled'].includes(w.status)))throw refused('compaction already unfinished');
      const work=this.records.create('work',{agentId:session.agentId,scope:session.scope,taskId:null,taskGeneration:null,messageId:null,episodeId:crypto.randomUUID(),purpose:'compaction',prompt:'Create a compact continuation note for THIS context only. Preserve the objective, decisions, unfinished tasks, paths, verification evidence and unresolved questions. Distinguish completed actions from proposed actions. Do not execute tools or continue the task. Return only the note, at most 6000 characters. This note will replace the native conversation context, not durable memory.',status:'pending',error:null,runId:null,notBefore:Date.now()});
      this.core.workforce.changed();return work;
    });
  }
  checkpoint(threadId:string,work:AgentWork,result:string):void {
    if(!result.trim())throw refused('compaction returned no continuation note; existing context retained');
    const session=this.core.workforce.session(threadId);
    this.core.journal.setSetting(`agents:checkpoint:${session.id}`,{text:result.slice(0,12000),at:Date.now(),workId:work.id});
    const thread=this.core.threads.require(threadId);
    releaseThread(threadId);
    // The explicit checkpoint replaces history. Keep the journal for inspection, without replaying it.
    const next={...thread,sessionId:null,sessionGeneration:(thread.sessionGeneration ?? 0)+1,context:null,promptCache:null};
    this.core.journal.putThread(next);this.core.bus.emit('thread.updated',next);
  }
}
