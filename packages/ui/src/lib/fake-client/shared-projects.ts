/** Owner control and connection leases for associated projects. */
import type { SharedProject, SharedProjectRef, SharedReviewConfig } from '@boite/contracts';
import type { FakeContext, FakeMethods } from './context';
import { fakeCore } from './coordination';
import { secureId } from '../secure-id';
import { validateSharedCompute } from './shared-compute';
import { validateReview } from './shared-access';
import { assertSharedActive, assertWorkerScope, cloneShared, endpoints, invalidShared, onceShared, notifyShared, projectReference, requireShared, remoteShared, refusedShared, sharedAccessState, sharedActor, sharedContact, sharedScope, sharedState, sharedText, sharedThreads, sharedView, granted } from './shared-state';

export function sharedProjectMethods(ctx: FakeContext) {
  sharedState(ctx);
  return {
    'sharedProjects.list': async p => {
      const thread = ctx.thread(p.threadId);
      const bound=sharedState(ctx).workerScopes.get(p.threadId);
      return [...sharedState(ctx).projects.values()].filter(s => endpoints(ctx,s).local.projectId === thread.projectId&&(!bound||bound===s.id)).map(s => {sharedActor(ctx,p.threadId,endpoints(ctx,s).local); return sharedView(ctx,s);});
    },
    'sharedProjects.get': async p => {assertWorkerScope(ctx,p);const s = requireShared(ctx,p.sharedProjectId); sharedActor(ctx,p.threadId,endpoints(ctx,s).local); return sharedView(ctx,s);},
    'sharedProjects.offer': async p => {
      const contact = sharedContact(ctx,p.coreId), local = {ownerCoreId: contact?.via ?? ctx.identity.coreId, coreId: p.machine ?? ctx.identity.coreId, projectId: p.projectId}, remote = projectReference(p.remote);
      if (local.coreId !== ctx.identity.coreId) throw refusedShared('machine: offer from the project owning Store/core');
      if (remote.ownerCoreId !== p.coreId || !granted(ctx,local,p.coreId)) throw refusedShared('projectId: expected a project explicitly granted to this contact');
      if (contact?.capabilities?.sharedProjects !== 1) throw refusedShared('coreId: contact must negotiate sharedProjects version 1');
      const id = onceShared(ctx, `offer:${p.projectId}:${sharedText(p.requestId,'requestId')}`,p,() => {
        const initial = (project: SharedProjectRef) => ({project,revision:1,board:false,compute:{enabled:false,profiles:[],permissionMode:'default' as const,maxConcurrent:null},revokedAt:null});
        const shared: SharedProject = {id:`shp_${secureId()}`,projects:[local,remote],authority:local,state:'pending',access:[initial(local),initial(remote)],createdAt:Date.now(),updatedAt:Date.now()};
        sharedState(ctx).projects.set(shared.id,shared);
        sharedState(ctx).policies.set(shared.id,JSON.stringify(sharedContact(ctx,p.coreId,local)?.grants.find(g=>g.projectId===local.projectId)));
        const target = fakeCore(remote.coreId);
        if (target && granted(target,remote,local.ownerCoreId)) {sharedState(target).projects.set(shared.id,shared);sharedState(target).policies.set(shared.id,JSON.stringify(sharedContact(target,local.ownerCoreId,remote)?.grants.find(g=>g.projectId===remote.projectId)));}
        else if (target) shared.state = 'declined';
        return shared.id;
      });
      notifyShared(ctx,id); return sharedView(ctx,requireShared(ctx,id));
    },
    'sharedProjects.decide': async p => {
      if (typeof p.accept !== 'boolean') throw invalidShared('accept: expected a boolean');
      const s = requireShared(ctx,p.sharedProjectId), {local,remote,index} = endpoints(ctx,s);
      onceShared(ctx,`control:${s.id}:${sharedText(p.requestId,'requestId')}`,p,() => {
        if (index !== 1 || s.state !== 'pending' || !granted(ctx,local,remote.ownerCoreId)) throw refusedShared('sharedProjectId: expected an incoming pending association');
        s.state = p.accept ? 'active' : 'declined'; s.updatedAt = Date.now(); return true;
      }); notifyShared(ctx,s.id); return sharedView(ctx,s);
    },
    'sharedProjects.revoke': async p => {
      const s = requireShared(ctx,p.sharedProjectId), {index} = endpoints(ctx,s);
      onceShared(ctx,`control:${s.id}:${sharedText(p.requestId,'requestId')}`,p,() => {s.state='revoked'; s.access[index].revokedAt=Date.now(); s.access[index].revision++; return true;});
      notifyShared(ctx,s.id); return sharedView(ctx,s);
    },
    'sharedProjects.configure': async p => {
      const s = requireShared(ctx,p.sharedProjectId), {index} = endpoints(ctx,s); assertSharedActive(ctx,s);
      if (p.board !== undefined && typeof p.board !== 'boolean') throw invalidShared('board: expected a boolean');
      if (p.computeThreadId !== undefined && p.compute === undefined) throw invalidShared('computeThreadId: expected compute policy');
      const compute = p.compute === undefined ? undefined : validateSharedCompute(ctx,s,p);
      const reviewer: SharedReviewConfig | undefined = p.reviewer === undefined ? undefined : validateReview(ctx,p.reviewer);
      const next = {...s.access[index],...(p.board === undefined ? {} : {board:p.board}),...(compute === undefined ? {} : {compute:compute.policy})};
      if (JSON.stringify(next)!==JSON.stringify(s.access[index]) || compute?.rebound) {next.revision++; s.access[index]=next;}
      if (compute) compute.commit();
      if (reviewer) sharedAccessState(ctx,s.id).review=reviewer;
      notifyShared(ctx,s.id); return sharedView(ctx,s);
    },
    'sharedProjects.threads': async p => {
      const {shared,local,remote} = sharedScope(ctx,p), target = remoteShared(ctx,shared);
      return cloneShared({threads:[...sharedThreads(ctx,shared,local,ctx),...(target ? sharedThreads(target,requireShared(target,shared.id),remote,ctx):[])],unavailable:target?[]:[remote]});
    },
    'sharedProjects.subscribe': async p => {
      if (typeof p.enabled !== 'boolean') throw invalidShared('enabled: expected a boolean');
      const key = JSON.stringify([p.threadId,p.sharedProjectId]);
      if (p.enabled) {sharedScope(ctx,p); sharedState(ctx).subscriptions.set(key,{threadId:p.threadId,sharedProjectId:p.sharedProjectId});}
      else sharedState(ctx).subscriptions.delete(key);
      return {ok:true as const};
    },
  } satisfies Partial<FakeMethods>;
}
