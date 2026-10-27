/** Host-owned routes and captured fake jobs. Fixture Git is explicit; no caller result is trusted. */
import { CONVERSATION_PROFILE_ID, type Protocol, type PermissionMode, type SharedExecutionProtection, type SharedComputeJob, type SharedComputePolicy, type SharedComputeRoute, type SharedProject, type SharedProjectRef, type RpcParams } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { contactState, modelTier } from './contacts';
import { delegationConfig, workflowChild, workflowAnswer, type ChildRoute } from './delegation';
import { secureId } from '../secure-id';
import { assertSharedActive, cloneShared, endpoints, invalidShared, notifyShared, onceShared, projectAddress, remoteShared, requireShared, refusedShared, sameProject, sharedScope, sharedState, sharedText } from './shared-state';

interface Record {job:SharedComputeJob;content:string;task:string;repository:string;parent:string;base:string;accountId:string;cancelRequest?:string;claimClosed?:true}
interface HostState {nativeProtected:boolean;bindings:Map<string,string>;jobs:Map<string,Record>;requests:Map<string,Record>;sources:Map<string,Record>;repos:Map<string,{repository:string;head:string;commits:Set<string>}>}
const states=new WeakMap<FakeContext,HostState>();
function stateOf(ctx:FakeContext):HostState{let state=states.get(ctx);if(!state){state={nativeProtected:false,bindings:new Map(),jobs:new Map(),requests:new Map(),sources:new Map(),repos:new Map()};states.set(ctx,state);}return state;}
const terminal=(job:SharedComputeJob)=>['done','failed','cancelled','revoked'].includes(job.status);
/** Fixture capability only. The in-memory client never attests an actual OS boundary. */
export function setSharedNativeExecution(ctx:FakeContext,available:boolean):void{stateOf(ctx).nativeProtected=available;}
export function sharedPermission(protocol:Protocol,mode:PermissionMode,providerId?:string):boolean{
  if(protocol==='pi')return mode==='yolo'||mode==='bypassPermissions';
  if(protocol==='acp')return providerId==='opencode'&&(mode==='default'||mode==='plan');
  return protocol!=='echo'||mode==='default';
}
export function sharedProtection(ctx:FakeContext,protocol:Protocol,providerId?:string,mode?:PermissionMode):SharedExecutionProtection{
  if(mode&&!sharedPermission(protocol,mode,providerId))return {supported:false,reason:`execution.permissionMode: ${providerId??protocol} cannot enforce ${mode}`};
  if(protocol==='echo')return {supported:true,boundary:'no-tools'};
  if(stateOf(ctx).nativeProtected&&(protocol==='claude-sdk'||protocol==='codex-appserver'||protocol==='muse'||protocol==='pi'||protocol==='acp'&&providerId==='opencode'))return {supported:true,boundary:'isolated-process'};
  return {supported:false,reason:`${protocol}: protected shared execution is unavailable`};
}
export function setSharedRepository(ctx:FakeContext,projectId:string,repository:string,head:string):void{
  if(!ctx.projects.some(p=>p.id===projectId)||!/^https:\/\/[^/@\s]+\/[^?\s]+$/.test(repository)||!/^([a-f0-9]{40}|[a-f0-9]{64})$/.test(head))throw invalidShared('repository fixture: expected a project, credential-free repository and full commit');
  stateOf(ctx).repos.set(projectId,{repository,head,commits:new Set([head])});
}
function parentRoute(ctx:FakeContext,shared:SharedProject,profileId:string,threadId=stateOf(ctx).bindings.get(shared.id)):{parent:ReturnType<FakeContext['thread']>;route:ChildRoute}{
  if(!threadId)throw refusedShared('compute: the host must choose a local conversation before opting in');
  const parent=ctx.thread(threadId),config=delegationConfig(ctx,parent.id),{local}=endpoints(ctx,shared);
  if(parent.parentThreadId||parent.archived||parent.projectId!==local.projectId||!config.enabled||config.paused)throw refusedShared('computeThreadId: expected an active local parent with delegation enabled');
  const route:ChildRoute|undefined=profileId===CONVERSATION_PROFILE_ID?{id:profileId,name:parent.model??parent.providerId,providerId:parent.providerId,accountId:parent.accountId,model:parent.model,effort:parent.effort??null}:config.profiles.find(p=>p.id===profileId);
  if(!route||!ctx.accounts.some(a=>a.id===route.accountId&&a.providerId===route.providerId))throw refusedShared('compute.profileId: expected an offered host delegation profile');
  return {parent,route};
}
export function validateSharedCompute(ctx:FakeContext,shared:SharedProject,p:RpcParams<'sharedProjects.configure'>){
  const policy=p.compute!;
  if(!policy||typeof policy.enabled!=='boolean'||!Array.isArray(policy.profiles)||policy.profiles.length>100||!['default','plan','acceptEdits','bypassPermissions','yolo','dontAsk'].includes(policy.permissionMode)||(policy.maxConcurrent!==null&&(!Number.isSafeInteger(policy.maxConcurrent)||policy.maxConcurrent<1)))throw invalidShared('access.compute: expected enabled, profiles, permissionMode and positive maxConcurrent or null');
  policy.profiles.forEach(id=>sharedText(id,'compute.profiles',128));
  if(policy.enabled){
    if(!policy.profiles.length||new Set(policy.profiles).size!==policy.profiles.length)throw invalidShared('compute.profiles: expected distinct host profile IDs');
    for(const profileId of policy.profiles){const {route}=parentRoute(ctx,shared,profileId,p.computeThreadId);const protocol=ctx.providers.find(p=>p.id===route.providerId)?.protocol;
      if(!protocol||!sharedPermission(protocol,policy.permissionMode,route.providerId))throw refusedShared(`compute.permissionMode: ${protocol} cannot attest this shared execution permission policy`);
    }
  }
  return {policy:cloneShared(policy),rebound:policy.enabled&&p.computeThreadId!==undefined&&stateOf(ctx).bindings.get(shared.id)!==p.computeThreadId,commit:()=>{if(policy.enabled&&p.computeThreadId)stateOf(ctx).bindings.set(shared.id,p.computeThreadId);}};
}
function hostFor(ctx:FakeContext,shared:SharedProject,ref:SharedProjectRef):FakeContext{
  const {local,remote}=endpoints(ctx,shared);
  if(sameProject(ref,local))return ctx;
  if(!sameProject(ref,remote))throw refusedShared('compute.host: expected one of the two associated endpoints');
  const target=remoteShared(ctx,shared);if(!target)throw refusedShared('compute.host: execution host unavailable');return target;
}
function routes(ctx:FakeContext,shared:SharedProject):SharedComputeRoute[]{
  const policy=shared.access[endpoints(ctx,shared).index].compute;
  if(!policy.enabled)throw refusedShared('compute: this project host has not opted in');
  return policy.profiles.map(profileId=>{
    const {route}=parentRoute(ctx,shared,profileId),provider=ctx.providers.find(p=>p.id===route.providerId)!;
    if(!provider?.available)throw refusedShared('compute.providerId: host provider unavailable');
    return {profileId,providerId:provider.id,protocol:provider.protocol,model:route.model,efforts:provider.models.find(m=>m.id===route.model)?.effort?.levels.map(l=>l.id)??[],permissionMode:policy.permissionMode,
      protection:sharedProtection(ctx,provider.protocol,route.providerId,policy.permissionMode)};
  });
}
export function finishSharedCompute(ctx:FakeContext,jobId:string,text:string):void{
  const record=stateOf(ctx).jobs.get(jobId);if(!record||terminal(record.job))return;
  const shared=requireShared(ctx,record.job.sharedProjectId);assertSharedActive(ctx,shared);
  const worker=record.job.worker!;
  workflowAnswer(ctx,worker.threadId,text,true);
  const repo=stateOf(ctx).repos.get(worker.project.projectId)!;
  record.job={...record.job,revision:record.job.revision+1,status:'done',updatedAt:Date.now(),result:{repository:record.repository,branch:ctx.thread(worker.threadId).branch!,baseCommit:record.base,commit:repo.head,dirty:false,text:text.slice(0,4000)}};
  notifyShared(ctx,shared.id);
}
function computeSource(ctx:FakeContext,p:{threadId:string;sharedProjectId:string}) {
  const scope=sharedScope(ctx,p),thread=ctx.thread(p.threadId);
  if(modelTier(thread.providerId,thread.model)>contactState(ctx).settings.minTier)throw refusedShared('threadId: model is below the contact tier');
  return scope;
}
function records(ctx:FakeContext,s:SharedProject,threadId:string):{host:FakeContext;record:Record}[]{
  const local=endpoints(ctx,s).local;
  return [...new Map([...stateOf(ctx).jobs.values(),...stateOf(ctx).sources.values()].filter(r=>r.job.sharedProjectId===s.id&&(ctx.bus.principal!=='agent'||sameProject(r.job.source.project,local)&&r.job.source.threadId===threadId)).map(record=>[record.job.id,{host:record.job.host.coreId===ctx.identity.coreId?ctx:remoteShared(ctx,s)??ctx,record}])).values()];
}
export function sharedComputeMethods(ctx:FakeContext){
  sharedState(ctx).hostJob=(id,jobId)=>{const job=stateOf(ctx).jobs.get(jobId)?.job;return job?.sharedProjectId===id?job:undefined;};
  sharedState(ctx).listeners.add(id=>{
    const s=requireShared(ctx,id),policy=s.access[endpoints(ctx,s).index].compute;
    for(const record of stateOf(ctx).jobs.values()) {
      if(record.job.sharedProjectId!==id||['revoked','cancelled'].includes(record.job.status))continue;
      let live=s.state==='active'&&policy.enabled&&policy.profiles.includes(record.job.profileId)&&record.job.grantRevision===s.access[endpoints(ctx,s).index].revision;
      try {
        const {parent,route}=parentRoute(ctx,s,record.job.profileId),worker=record.job.worker&&ctx.thread(record.job.worker.threadId);
        if(parent.id!==record.parent||route.accountId!==record.accountId||route.providerId!==record.job.providerId||route.model!==record.job.model||(route.effort??null)!==record.job.effort||worker&&(worker.archived||worker.parentThreadId!==parent.id||worker.accountId!==record.accountId||worker.providerId!==record.job.providerId||worker.model!==record.job.model||worker.permissionMode!==record.job.permissionMode))live=false;
      }catch{live=false;}
      if(live)continue;
      record.job={...record.job,status:'revoked',revision:record.job.revision+1,result:null,updatedAt:Date.now()};
      const worker=record.job.worker;if(worker){const running=ctx.inFlight.get(worker.threadId);if(running)running.cancelled=true;ctx.thread(worker.threadId).status='idle';}
    }
    for(const source of stateOf(ctx).sources.values()) {
      if(source.job.sharedProjectId!==id)continue;
      const host=source.job.host.coreId===ctx.identity.coreId?ctx:remoteShared(ctx,s);
      const record=host&&stateOf(host).jobs.get(source.job.id);
      if(!record)continue;
      if(source.cancelRequest&&!terminal(record.job)) {
        record.job={...record.job,status:'cancelled',error:null,result:null,revision:record.job.revision+1,updatedAt:Date.now()};
        if(record.job.worker){const running=host!.inFlight.get(record.job.worker.threadId);if(running)running.cancelled=true;host!.thread(record.job.worker.threadId).status='idle';}
      }
      source.job=cloneShared(record.job);
      if(terminal(source.job))delete source.cancelRequest;
    }
  });
  sharedState(ctx).stopClaim=(id,claimId,worker)=>{
    for(const record of [...stateOf(ctx).jobs.values(),...stateOf(ctx).sources.values()])if(record.job.sharedProjectId===id&&record.job.claimId===claimId&&JSON.stringify(record.job.source)===JSON.stringify(worker)){
      record.claimClosed=true;
      if(!terminal(record.job))record.job={...record.job,status:'cancelled',result:null,revision:record.job.revision+1};
    }
  };
  function job(p:{threadId:string;sharedProjectId:string;jobId:string}){
    const {shared}=sharedScope(ctx,p),found=records(ctx,shared,p.threadId).find(r=>r.record.job.id===p.jobId);
    if(!found)throw refusedShared('jobId: expected a captured job in this source/host scope');return {...found,shared};
  }
  return {
    'sharedCompute.host':async p=>{requireShared(ctx,p.sharedProjectId);return {threadId:stateOf(ctx).bindings.get(p.sharedProjectId)??null};},
    'sharedCompute.models':async p=>{const {shared}=computeSource(ctx,p);return cloneShared(routes(hostFor(ctx,shared,p.host),shared));},
    'sharedCompute.start':async p=>{
      const {shared,local}=computeSource(ctx,p);
      for(const key of Object.keys(p))if(!['threadId','sharedProjectId','requestId','host','profileId','task','title','baseCommit','claimId'].includes(key))throw invalidShared(`compute.${key}: expected only job fields`);
      sharedText(p.requestId,'requestId');sharedText(p.task,'task',12000);if(p.title!==undefined)sharedText(p.title,'title',120);
      if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(p.baseCommit))throw invalidShared('baseCommit: expected a full lowercase git commit object id');
      const host=hostFor(ctx,shared,p.host),route=routes(host,shared).find(r=>r.profileId===p.profileId);
      if(!route)throw refusedShared('compute.profileId: expected an explicitly offered profile');
      if(!route.protection.supported)throw refusedShared(`compute.protection: ${route.protection.reason}`);
      const sourceRepo=stateOf(ctx).repos.get(local.projectId),hostRepo=stateOf(host).repos.get(p.host.projectId);
      if(!sourceRepo||!hostRepo||sourceRepo.repository!==hostRepo.repository||!sourceRepo.commits.has(p.baseCommit)||!hostRepo.commits.has(p.baseCommit))throw refusedShared('compute.repository/baseCommit: expected the same registered repository and a verified common commit');
      const source={project:local,threadId:p.threadId,address:projectAddress(local,p.threadId)},key=JSON.stringify([shared.id,source,p.requestId]),content=JSON.stringify(p),saved=stateOf(host).requests.get(key);
      if(saved){if(saved.content!==content)throw refusedShared('requestId: already used for different compute content');return cloneShared(saved.job);}
      const policy=shared.access[endpoints(host,shared).index].compute;
      if(policy.maxConcurrent!==null&&[...stateOf(host).jobs.values()].filter(r=>r.job.sharedProjectId===shared.id&&!terminal(r.job)).length>=policy.maxConcurrent)throw refusedShared('compute: host contribution is full');
      if(p.claimId)sharedText(p.claimId,'claimId');
      const resolved=parentRoute(host,shared,p.profileId),child=workflowChild(host,resolved.parent,resolved.route,p.title??p.task.slice(0,120),p.task),thread=host.thread(child),worker={project:p.host,threadId:child,address:projectAddress(p.host,child)};
      thread.permissionMode=policy.permissionMode;thread.branch=`boite/sub-${child.slice(4,14)}`;thread.cwd=`${host.projects.find(pr=>pr.id===p.host.projectId)!.path}/.boite/worktrees/${child}`;
      const now=Date.now(),record:Record={content,task:p.task,repository:hostRepo.repository,parent:resolved.parent.id,accountId:resolved.route.accountId,base:p.baseCommit,job:{id:`scj_${secureId()}`,revision:1,sharedProjectId:shared.id,requestId:p.requestId,source,host:p.host,worker,grantRevision:shared.access[endpoints(host,shared).index].revision,profileId:p.profileId,providerId:route.providerId,model:route.model,effort:resolved.route.effort,permissionMode:policy.permissionMode,status:'running',claimId:p.claimId??null,result:null,error:null,createdAt:now,updatedAt:now}};
      // Keep a source namespace key and the public job id pointed at one record.
      stateOf(host).requests.set(key,record);stateOf(host).jobs.set(record.job.id,record);stateOf(ctx).sources.set(record.job.id,host===ctx?record:cloneShared(record));
      sharedState(host).workerScopes.set(child,shared.id);
      sharedState(host).workerRevisions.set(child,record.job.grantRevision);sharedState(host).workerJobs.set(child,record.job.id);
      if(p.claimId){try{sharedState(host).checkClaim?.(shared,source,p.claimId);if(!sharedState(host).checkClaim)throw refusedShared('claim authority unavailable');}catch{record.job.status='failed';record.job.error='Host could not admit the captured checkout, execution policy or provider';}}
      notifyShared(ctx,shared.id);return cloneShared(record.job);
    },
    'sharedCompute.list':async p=>{const {shared}=sharedScope(ctx,p);return cloneShared([...new Map(records(ctx,shared,p.threadId).map(r=>[r.record.job.id,r.record.job])).values()]);},
    'sharedCompute.get':async p=>{
      const {record,shared}=job(p);
      if(record.job.host.coreId!==ctx.identity.coreId&&!terminal(record.job)) {
        computeSource(ctx,p);const host=remoteShared(ctx,shared);if(!host)throw refusedShared('compute.host: execution host unavailable');
        record.job=cloneShared(stateOf(host).jobs.get(record.job.id)!.job);
      }
      return cloneShared(record.job);
    },
    'sharedCompute.send':async p=>{
      computeSource(ctx,p);const found=job(p),{host,shared}=found,text=sharedText(p.text,'text',4000),requestId=sharedText(p.requestId,'requestId');
      if(found.record.job.host.coreId!==ctx.identity.coreId&&!remoteShared(ctx,shared))throw refusedShared('compute.host: unavailable');
      const record=stateOf(host).jobs.get(found.record.job.id)!;
      if(record.claimClosed||found.record.claimClosed)throw refusedShared('compute.claim: reservation is permanently closed');
      if(terminal(record.job)&&record.job.status!=='done'||found.record.cancelRequest)throw refusedShared('jobId: execution authority is closed');
      return onceShared(host,`compute-send:${record.job.id}:${requestId}`,{text},()=>{record.job={...record.job,status:'running',revision:record.job.revision+1,result:null};notifyShared(ctx,shared.id);return {ok:true as const};});
    },
    'sharedCompute.cancel':async p=>{
      const {host,record,shared}=job(p);const requestId=sharedText(p.requestId,'requestId');
      if(terminal(record.job))return cloneShared(record.job);
      if(record.job.host.coreId!==ctx.identity.coreId) {
        record.cancelRequest??=requestId;record.job={...record.job,status:'uncertain',error:'Cancellation pending',result:null,revision:record.job.revision+1};
        notifyShared(ctx,shared.id);return cloneShared(record.job);
      }
      if(!terminal(record.job)){record.job={...record.job,status:'cancelled',revision:record.job.revision+1,result:null,updatedAt:Date.now()};if(record.job.worker)host.thread(record.job.worker.threadId).status='idle';notifyShared(ctx,shared.id);}
      return cloneShared(record.job);
    },
  } satisfies Partial<FakeMethods>;
}
