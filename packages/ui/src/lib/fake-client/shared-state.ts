/** In-memory counterpart of the scoped Contacts protocol. No foreign thread is inserted locally. */
import { RpcErrorCode, type Contact, type RpcParams, type SharedProject, type SharedProjectActor, type SharedProjectRef, type SharedProjectScope, type SharedProjectView, type SharedProjectThread, type SharedAccessEvent, type SharedReviewVerdict, type SharedFileOverride, type SharedReviewConfig } from '@boite/contracts';
import { RpcFailure } from '../client';
import { secureId } from '../secure-id';
import type { FakeContext, FakeMethods } from './context';
import { coordinationConfig, fakeCore } from './coordination';
import { contactFor, contactState, modelTier } from './contacts';

export const invalidShared = (message: string) => new RpcFailure({code: RpcErrorCode.InvalidParams, message});
export const refusedShared = (message: string) => new RpcFailure({code: RpcErrorCode.Refused, message});
export const sameProject = (a: SharedProjectRef, b: SharedProjectRef) => a.ownerCoreId === b.ownerCoreId && a.coreId === b.coreId && a.projectId === b.projectId;
export const projectAddress = (p: SharedProjectRef, threadId: string) => ({coreId: p.ownerCoreId, threadId: p.coreId === p.ownerCoreId ? threadId : `${threadId}~${p.coreId.slice(0,16)}`});
export const cloneShared = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** Same conservative text projection as the core's Contacts file policy. */
export function sharedTextProjection(value: string): string {
  return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/i.test(value)
    || /(?:^|[\s{,])\s*["']?(?:[\w.-]*[_-])?(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*\S+/i.test(value)
    ? '[Shared file policy withheld credential-like text]' : value;
}
export function sharedText(value: unknown, field: string, max = 100): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidShared(`${field}: expected 1 to ${max} characters`);
  return value;
}
export function projectReference(value: SharedProjectRef): SharedProjectRef {
  if (!value || typeof value.ownerCoreId !== 'string' || !/^[a-f0-9]{64}$/.test(value.ownerCoreId) || typeof value.coreId !== 'string' || !/^[a-f0-9]{64}$/.test(value.coreId)) throw invalidShared('project: expected ownerCoreId and coreId');
  return {ownerCoreId: value.ownerCoreId, coreId: value.coreId, projectId: sharedText(value.projectId, 'projectId', 128)};
}
interface State {
  projects: Map<string, SharedProject>;
  receipts: Map<string, {content: string; result: unknown}>;
  subscriptions: Map<string, SharedProjectScope>;
  listeners: Set<(id: string) => void>;
  policies: Map<string,string>;
  workerScopes: Map<string,string>;
  workerRevisions: Map<string,number>;
  workerJobs: Map<string,string>;
  checkClaim?: (shared:SharedProject,source:import('@boite/contracts').SharedThreadRef,claimId:string)=>void;
  stopClaim?: (sharedId:string,claimId:string,worker:import('@boite/contracts').SharedThreadRef)=>void;
  hostJob?: (sharedId:string,jobId:string)=>import('@boite/contracts').SharedComputeJob|undefined;
}
const states = new WeakMap<FakeContext, State>();
const connected = new Set<FakeContext>();
export function sharedState(ctx: FakeContext): State {
  let state = states.get(ctx);
  if (state) return state;
  state = {projects: new Map(), receipts: new Map(), subscriptions: new Map(), listeners: new Set(), policies:new Map(), workerScopes:new Map(), workerRevisions:new Map(), workerJobs:new Map()};
  states.set(ctx, state);
  connected.add(ctx);
  ctx.bus.onState(s => { if (s !== 'ready') state.subscriptions.clear(); if (s === 'closed') connected.delete(ctx); });
  for (const event of ['contacts.updated', 'group.updated', 'project.updated', 'project.removed', 'thread.updated', 'thread.removed', 'delegation.changed'] as const) ctx.bus.on(event, () => reconcileShared(ctx));
  return state;
}
export function onceShared<T>(ctx: FakeContext, key: string, input: unknown, run: () => T, contentRefusal = false): T {
  const state = sharedState(ctx), content = JSON.stringify(input), saved = state.receipts.get(key);
  if (saved) { if (saved.content !== content) throw (contentRefusal ? refusedShared : invalidShared)('requestId: already used for different content'); return cloneShared(saved.result as T); }
  const result = run(); state.receipts.set(key, {content, result: cloneShared(result)}); return result;
}
export function endpoints(ctx: FakeContext, shared: SharedProject) {
  const index = shared.projects[0].coreId === ctx.identity.coreId ? 0 : 1;
  return {local: shared.projects[index]!, remote: shared.projects[index === 0 ? 1 : 0]!, index: index as 0 | 1};
}
export function requireShared(ctx: FakeContext, id: string): SharedProject {
  const shared = sharedState(ctx).projects.get(sharedText(id, 'sharedProjectId'));
  if (!shared) throw refusedShared('sharedProjectId: expected an associated project of this core');
  return shared;
}
export function sharedContact(ctx: FakeContext, id: string, local?: SharedProjectRef): (Contact & {via?: string}) | undefined { return contactFor(ctx, id, local?.ownerCoreId); }
export function granted(ctx: FakeContext, ref: SharedProjectRef, peer: string): boolean {
  return ref.coreId === ctx.identity.coreId && ctx.projects.some(p => p.id === ref.projectId && !p.archived)
    && sharedContact(ctx, peer, ref)?.grants.some(g => g.projectId === ref.projectId && (!g.machine || g.machine === ref.coreId)) === true;
}
export function assertSharedActive(ctx: FakeContext, shared: SharedProject): void {
  const {local, remote} = endpoints(ctx, shared);
  if (shared.state !== 'active' || shared.access.some(a => a.revokedAt !== null) || !granted(ctx, local, remote.ownerCoreId)) throw refusedShared('sharedProjectId: association or project grant is not active');
}
export function sharedActor(ctx: FakeContext, threadId: string, local: SharedProjectRef): SharedProjectActor {
  const thread = ctx.thread(threadId), config = coordinationConfig(ctx, threadId);
  if (thread.archived || thread.projectId !== local.projectId || config.mode === 'off' || !config.remote) throw refusedShared('threadId: expected an unarchived source of the associated project with remote coordination enabled');
  if (ctx.bus.principal !== 'agent') return {kind: 'human', project: local};
  if (ctx.agentThreadId !== threadId) throw refusedShared('threadId: expected the authenticated agent source');
  const agent = `${thread.providerId} ${thread.model ?? ''}`;
  if (modelTier(thread.providerId, thread.model) > contactState(ctx).settings.minTier) throw refusedShared('threadId: model is below the contact tier');
  return {kind: 'agent', project: local, threadId, address: projectAddress(local,threadId), agent};
}
export function sharedScope(ctx: FakeContext, p: SharedProjectScope) {
  assertWorkerScope(ctx,p);
  const shared = requireShared(ctx, p.sharedProjectId);
  assertSharedActive(ctx, shared);
  const {local, remote, index} = endpoints(ctx, shared);
  return {shared, local, remote, index, source: sharedActor(ctx, p.threadId, local)};
}
export function assertWorkerScope(ctx:FakeContext,p:SharedProjectScope):void {
  const bound=sharedState(ctx).workerScopes.get(p.threadId);
  if(bound&&bound!==p.sharedProjectId)throw refusedShared('sharedProjectId: expected this worker association');
}
export function remoteShared(ctx: FakeContext, shared: SharedProject): FakeContext | undefined {
  const {local, remote} = endpoints(ctx, shared), contact = sharedContact(ctx, remote.ownerCoreId, local), target = fakeCore(remote.coreId);
  return contact?.link === 'connected' && target && sharedContact(target, local.ownerCoreId, remote)?.link === 'connected' ? target : undefined;
}
export function notifyShared(ctx: FakeContext, id: string, kinds: import('@boite/contracts').SharedProjectChangeKind[] = ['threads','board','compute','access']): void {
  for (const side of connected) {
    const state = sharedState(side);
    if (!state.projects.has(id)) continue;
    for (const listener of state.listeners) listener(id);
    for (const [key, p] of state.subscriptions) {
      if (p.sharedProjectId !== id) continue;
      const shared = state.projects.get(id)!;
      let live = shared.state === 'active';
      try { sharedActor(side, p.threadId, endpoints(side, shared).local); } catch { live = false; }
      side.bus.deliver('sharedProjects.changed', {...cloneShared(p),kinds:[...kinds]});
      if (!live) state.subscriptions.delete(key);
    }
  }
}
export function reconcileShared(ctx: FakeContext): void {
  for (const shared of sharedState(ctx).projects.values()) {
    const {local, remote, index} = endpoints(ctx, shared);
    if (shared.state !== 'revoked' && !granted(ctx, local, remote.ownerCoreId)) {
      shared.state = 'revoked'; shared.access[index].revokedAt = Date.now(); shared.access[index].revision++;
    }
    const policy=JSON.stringify(sharedContact(ctx,remote.ownerCoreId,local)?.grants.find(g=>g.projectId===local.projectId));
    const previous=sharedState(ctx).policies.get(shared.id);
    if (previous!==undefined && policy!==previous && shared.state==='active') shared.access[index].revision++;
    sharedState(ctx).policies.set(shared.id,policy??'missing');
    notifyShared(ctx, shared.id);
  }
}
export function sharedView(ctx: FakeContext, shared: SharedProject): SharedProjectView {
  const {local, remote} = endpoints(ctx, shared), contact = sharedContact(ctx, remote.ownerCoreId,local), access = sharedAccessState(ctx, shared.id);
  return cloneShared({shared, local, remote, contact: {coreId: remote.ownerCoreId, name: contact?.name ?? 'Contact'},
    connection: remoteShared(ctx, shared) ? 'connected' : sameProject(shared.authority, remote) ? 'authority-unavailable' : 'offline',
    protection: {defaultDeny: true, activeOverrides: shared.state === 'active' ? access.overrides.filter(o => o.revokedAt === null && o.expiresAt > Date.now() && access.identities.get(o.id) === JSON.stringify([shared.access[endpoints(ctx,shared).index].revision,ctx.files.get(o.path)])).length : 0, reviewer: access.review.enabled ? 'idle' : 'off'}});
}
export function sharedThreads(ctx: FakeContext, shared: SharedProject, project: SharedProjectRef, viewer: FakeContext): SharedProjectThread[] {
  assertSharedActive(ctx, shared);
  return [...ctx.threads.values()].filter(t => t.projectId === project.projectId && !t.archived && coordinationConfig(ctx, t.id).mode !== 'off' && coordinationConfig(ctx, t.id).remote).sort((a,b) => b.updatedAt - a.updatedAt).slice(0,100).map(t => {
    const ref = {project, threadId: t.id, address: projectAddress(project,t.id)};
    const agent = {coreId: ref.address.coreId, threadId: ref.address.threadId, title: t.title, machine: ctx.identity.name, resources: coordinationConfig(ctx, t.id).resources, status: t.status, mode: coordinationConfig(ctx, t.id).mode,
      project: ctx.projects.find(p => p.id === project.projectId)?.name, agent: `${t.providerId}${t.model ? ` ${t.model}` : ''}`, branch: t.branch, activeAt: t.updatedAt, sharedThread: ref};
    const safe={...agent,title:sharedTextProjection(agent.title),machine:sharedTextProjection(agent.machine),resources:sharedTextProjection(agent.resources),...(agent.project?{project:sharedTextProjection(agent.project)}:{}),...(agent.branch?{branch:sharedTextProjection(agent.branch)}:{}),agent:sharedTextProjection(agent.agent)};
    const viewerOwner = endpoints(viewer,shared).local.ownerCoreId;
    return {ref, agent:safe, machine: sharedTextProjection(ctx.identity.name), readThreads: ctx === viewer || sharedContact(ctx, viewerOwner,project)?.grants.find(g => g.projectId === project.projectId)?.readThreads === true};
  });
}

interface AccessState {identities:Map<string,string>; roots:Map<string,string>; events: SharedAccessEvent[]; verdicts: SharedReviewVerdict[]; overrides: SharedFileOverride[]; review: SharedReviewConfig}
const accessStates = new WeakMap<FakeContext, Map<string, AccessState>>();
export function sharedAccessState(ctx: FakeContext, id: string): AccessState {
  let states = accessStates.get(ctx); if (!states) { states = new Map(); accessStates.set(ctx,states); }
  let state = states.get(id); if (!state) {state={identities:new Map(),roots:new Map(),events:[],verdicts:[],overrides:[],review:{enabled:false}}; states.set(id,state);}
  return state;
}
