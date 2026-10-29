/** Host-private protection configuration and sanitized access pages in the fake transport. */
import type { SharedProjectActor, SharedProject, SharedAccessAction, SharedReviewConfig, SharedAccessEvent, SharedSecretClass } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { assertWorkerScope, cloneShared, endpoints, invalidShared, notifyShared, onceShared, requireShared, sameProject, sharedAccessState, sharedScope, sharedText, sharedTextProjection, sharedState, assertSharedActive, refusedShared } from './shared-state';
import { secureId } from '../secure-id';

export function validateReview(ctx: FakeContext, input: SharedReviewConfig): SharedReviewConfig {
  if (!input || typeof input.enabled !== 'boolean') throw invalidShared('reviewer.enabled: expected a boolean');
  const keys = input.enabled ? ['enabled','providerId','accountId','model','effort','revokeOnViolation'] : ['enabled'];
  if (Object.keys(input).some(k => !keys.includes(k))) throw invalidShared('reviewer: expected only explicit inference route settings');
  if (!input.enabled) return {enabled:false};
  const providerId = sharedText(input.providerId,'reviewer.providerId'), accountId = sharedText(input.accountId,'reviewer.accountId');
  const provider = ctx.providers.find(p => p.id === providerId), account = ctx.accounts.find(a => a.id === accountId);
  if (!provider || !account) throw ctx.notFound(!provider ? 'provider':'account',!provider ? providerId:accountId);
  if (account.providerId !== provider.id) throw invalidShared('reviewer.accountId: expected an account of reviewer.providerId');
  if (typeof input.revokeOnViolation !== 'boolean') throw invalidShared('reviewer.revokeOnViolation: expected a boolean');
  return {enabled:true,providerId,accountId,model:input.model === null ? null : sharedText(input.model,'reviewer.model',200),effort:input.effort === null ? null : sharedText(input.effort,'reviewer.effort'),revokeOnViolation:input.revokeOnViolation};
}
export function recordSharedAccess(ctx: FakeContext, shared: SharedProject, actor: SharedProjectActor, action: SharedAccessAction, decision:SharedAccessEvent['decision']='allowed',reason='scoped-request',classification:SharedSecretClass|null=null,jobId:string|null=null): void {
  const state = sharedAccessState(ctx,shared.id);
  const event = {id:`sae_${secureId()}`,sharedProjectId:shared.id,actor:actor.kind==='human'?actor:{...actor,agent:'shared agent'},action,decision,reason,classification,jobId,at:Date.now()};
  state.events.push(event);
  if (state.review.enabled && !sameProject(actor.project,endpoints(ctx,shared).local)) {
    // Echo is not a verdict provider. No fake route silently invents a successful model judgment.
    state.verdicts.push({id:`srv_${secureId()}`,sharedProjectId:shared.id,eventIds:[event.id],verdict:'unavailable',reason:'Activity review could not produce a valid verdict',action:'none',at:Date.now()});
    notifyShared(ctx,shared.id,['access']);
  }
}
/** An in-memory file boundary for captured fixtures; filesystem identity is tested by the real core. */
export function fakeSharedFile(ctx:FakeContext,threadId:string,path:string,action:'read'|'publish'='read',quiet=false):void {
  const state=sharedState(ctx),id=state.workerScopes.get(threadId);if(!id)return;
  const shared=requireShared(ctx,id);assertSharedActive(ctx,shared);
  const {local,index}=endpoints(ctx,shared),jobId=state.workerJobs.get(threadId)??null,job=jobId?state.hostJob?.(id,jobId):undefined;
  if(state.workerRevisions.get(threadId)!==shared.access[index].revision||job&&['revoked','cancelled','failed','uncertain'].includes(job.status))throw refusedShared('shared file policy: job or host consent is closed');
  let classification:SharedSecretClass|null=null;
  const parts=path.split('/'),outside=/[:\\\x00-\x1f]/.test(path)||path.startsWith('/')||parts.some(p=>p==='..'||p!=='.'&&/[. ]$/.test(p));
  path=parts.filter(p=>p&&p!=='.').join('/');
  if(outside)classification='outside-project';
  else if(parts.some(p=>/^(?:\.env(?:\..*)?|\.envrc|\.dev\.vars)$/i.test(p)))classification='environment';
  else if(parts.some(p=>/^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.+\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(p)))classification='private-key';
  else if(parts.some(p=>/^(?:\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.?credentials?(?:\..*)?|\.?secrets?(?:\..*)?|\.netrc|_netrc|\.npmrc|\.pypirc|\.pgpass|\.htpasswd|\.git-credentials|.+\.(?:tfvars|tfstate|tfstate\.backup|kdbx))$/i.test(p)))classification='credential';
  else if(sharedTextProjection(ctx.files.get(path)??'')!==(ctx.files.get(path)??''))classification='secret';
  const access=sharedAccessState(ctx,id),override=classification!=='outside-project'&&access.overrides.some(o=>o.path===path&&o.revokedAt===null&&o.expiresAt>Date.now()&&o.actions.includes(action)&&(o.jobId===null||o.jobId===jobId)&&access.roots.get(o.id)===ctx.thread(threadId).cwd&&access.identities.get(o.id)===JSON.stringify([shared.access[index].revision,ctx.files.get(path)]));
  const actor:SharedProjectActor=job?{kind:'agent',...job.source,agent:'shared agent'}:{kind:'human',project:local};
  if(!quiet)recordSharedAccess(ctx,shared,actor,action==='publish'?'attachment':'file',classification&&!override?'denied':'allowed',classification?override?'host-override':'secret-file':'normal-file',classification,jobId);
  if(classification&&!override)throw refusedShared(`shared file policy: ${classification} requires a current exact host override`);
}
export function sharedAccessMethods(ctx: FakeContext) {
  return {
    'sharedAccess.get': async p => {
      assertWorkerScope(ctx,p);
      const s = requireShared(ctx,p.sharedProjectId), {local} = endpoints(ctx,s);
      // Like the core, owners retain their sanitized log after revocation.
      if (ctx.bus.principal === 'agent') sharedScope(ctx,p);
      else if (ctx.thread(p.threadId).projectId !== local.projectId) throw refusedShared('threadId: expected this associated project');
      const state=sharedAccessState(ctx,s.id), at=p.after===undefined?-1:state.events.findIndex(e=>e.id===p.after);
      if (p.after!==undefined && at<0) throw invalidShared('after: expected an access event of this association');
      const events=state.events.slice(at+1,at+101), ids=new Set(events.map(e=>e.id));
      return cloneShared({events,verdicts:state.verdicts.filter(v=>v.eventIds.some(id=>ids.has(id))),next:at+1+events.length<state.events.length?events.at(-1)!.id:null});
    },
    'sharedAccess.reviewConfig': async p => {requireShared(ctx,p.sharedProjectId); return cloneShared(sharedAccessState(ctx,p.sharedProjectId).review);},
    'sharedAccess.overrides': async p => {requireShared(ctx,p.sharedProjectId); return cloneShared(sharedAccessState(ctx,p.sharedProjectId).overrides);},
    'sharedAccess.override': async p => {
      const s=requireShared(ctx,p.sharedProjectId); assertSharedActive(ctx,s);
      const o=p.override;
      if (!o || Object.keys(o).some(k=>!['path','actions','jobId','reason','expiresAt'].includes(k))) throw invalidShared('override: expected path, actions, jobId, reason and expiresAt');
      if (!Array.isArray(o.actions)||!o.actions.length||new Set(o.actions).size!==o.actions.length||o.actions.some(a=>a!=='read'&&a!=='publish')) throw invalidShared('override.actions: expected read or publish; execute has no selective isolation boundary');
      if (!Number.isSafeInteger(o.expiresAt)||o.expiresAt<=Date.now()) throw invalidShared('override.expiresAt: expected a future timestamp');
      const path=sharedText(o.path,'override.path',4096),reason=sharedText(o.reason,'override.reason',500);
      if (o.jobId!==null && !sharedState(ctx).hostJob?.(s.id,sharedText(o.jobId,'override.jobId'))?.worker) throw refusedShared('override.jobId: expected a captured job of this association on this host');
      if (/[:\\\x00-\x1f]/.test(path)||path.startsWith('/')||path.split('/').some(p=>p==='..'||p==='.'||/[. ]$/.test(p))||!ctx.files.has(path)) throw refusedShared('shared file policy: override.path must be an existing exact file inside the selected host checkout');
      const value=onceShared(ctx,`override:${s.id}:${sharedText(p.requestId,'requestId')}`,p,()=>{
        const value={...o,path,reason,id:`sfo_${secureId()}`,sharedProjectId:s.id,revokedAt:null};
        const state=sharedAccessState(ctx,s.id),worker=o.jobId===null?null:sharedState(ctx).hostJob?.(s.id,o.jobId)?.worker;
        state.overrides.push(value);state.roots.set(value.id,worker?ctx.thread(worker.threadId).cwd:ctx.projects.find(p=>p.id===endpoints(ctx,s).local.projectId)!.path);state.identities.set(value.id,JSON.stringify([s.access[endpoints(ctx,s).index].revision,ctx.files.get(path)])); return value;
      });
      notifyShared(ctx,s.id,['access']); return cloneShared(value);
    },
    'sharedAccess.revokeOverride': async p => {
      requireShared(ctx,p.sharedProjectId);
      const o=sharedAccessState(ctx,p.sharedProjectId).overrides.find(o=>o.id===p.overrideId);
      if (!o) throw refusedShared('overrideId: expected a host override of this association');
      o.revokedAt ??= Date.now(); notifyShared(ctx,p.sharedProjectId,['access']); return {ok:true as const};
    },
  } satisfies Partial<FakeMethods>;
}
