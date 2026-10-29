import { randomUUID } from 'node:crypto';
import { realpathSync, type BigIntStats } from 'node:fs';
import { TOOL_FREE_CONTEXT, type ThreadSummary, type RpcMethodName, type RpcParams, type SharedAccessAction, type SharedAccessEvent, type SharedAccessPage, type SharedFileOverride, type SharedProjectActor, type SharedSecretClass } from '@boite/contracts';
import type { Core } from '../core.ts';
import type { Connection, RpcContext } from '../router.ts';
import { invalidParams, refused } from '../errors.ts';
import { text } from '../coordination-letter.ts';
import { SharedAccessJournal } from './access-journal.ts';
import { PolicyPathError, policyFile, policyIdentity, secretPath, secretText, type PolicyFile } from './file-policy.ts';
import type { SharedPeerContext } from './projects.ts';
import { accessBinding, computeBinding, type AccessBinding } from './access-scopes.ts';
import {letterScope} from './letter-scopes.ts';
import {SharedNativeExecution} from './native-execution.ts';

type FileAction = 'read' | 'publish';
interface PublicationFile {path: string; identity: string; content: SharedSecretClass | null}
interface Publication {threadId: string; binding: Omit<AccessBinding, 'compute'>; files: PublicationFile[]}
export interface SharedFilePermit { capture?(): PublicationFile; check(): void; opened?(real: string, stats: BigIntStats): void; inspect(value: Uint8Array | string): void }
/** Allowed routes have their own association/file gates. Everything else is closed for an external worker. */
const WORKER_METHODS = new Set<string>([
  'files.read', 'files.list', 'artifacts.publish', 'artifacts.read', 'artifacts.view', 'artifacts.previewClose',
  // Draft input/dependencies use publish permits; its ticket and result recheck consent.
  'artifacts.viewCheck',
  'sharedProjects.list', 'sharedProjects.get', 'sharedProjects.threads', 'sharedProjects.search', 'sharedProjects.read', 'sharedProjects.subscribe',
  'sharedBoard.get', 'sharedBoard.apply', 'sharedBoard.start', 'sharedCompute.models', 'sharedCompute.start', 'sharedCompute.list', 'sharedCompute.get', 'sharedCompute.send', 'sharedCompute.cancel',
  'sharedAccess.get', 'workflows.output', 'threads.tasks.get', 'threads.tasks.set', 'threads.capabilities',
  'collaboration.get', 'collaboration.wait',
]);
export type AccessReason = 'normal-file' | 'host-override' | 'secret-file' | 'path-boundary' | 'secret-content' | 'unsupported-tool' | 'scoped-request' | 'request-denied' | 'override-created' | 'override-revoked' | 'publication';

/** Synchronous deterministic enforcement; the optional reviewer consumes this feed later. No worker or timer. */
export class SharedAccess {
  readonly journal: SharedAccessJournal;
  readonly execution: SharedNativeExecution;
  readonly #listeners = new Set<(event: SharedAccessEvent) => void>();
  constructor(readonly core: Core) {
    this.journal = new SharedAccessJournal(core.journal.db);
    this.execution = new SharedNativeExecution(core, id => this.bound(id), binding => this.#live(binding));
    core.router.guard = (method, params, ctx) => this.#rpc(method, params, ctx);
    core.sharedCompute.publishText = (record, value) => {
      this.#live(computeBinding(record));
      const classification = secretText(value);
      this.record(this.#context(computeBinding(record)), 'result', classification ? 'denied' : 'allowed', classification ? 'secret-content' : 'publication', classification, record.job.id);
      return classification ? '[Shared file policy withheld credential-like result text]' : value;
    };
  }
  onEvent(listener: (event: SharedAccessEvent) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  record(ctx: Pick<SharedPeerContext, 'shared' | 'source'>, action: SharedAccessAction, decision: SharedAccessEvent['decision'], reason: AccessReason, classification: SharedSecretClass | null = null, jobId: string | null = null): SharedAccessEvent {
    const actor: SharedProjectActor = ctx.source.kind === 'human' ? ctx.source : {...ctx.source, agent: 'shared agent'};
    const event: SharedAccessEvent = {id: `sae_${randomUUID()}`, sharedProjectId: ctx.shared.id, actor, action, decision, reason, classification, jobId, at: Date.now()};
    this.journal.put(event);
    // Enforcement and persistence complete before a reviewer is scheduled. Review failures cannot allow a read.
    for (const listener of this.#listeners) { try { listener(event); } catch { /* The deterministic gate already decided. */ } }
    return event;
  }
  /** Only a journalled deterministic denial is local confirmation; model-supplied metadata is never confirmation. */
  confirmed(id: string, sharedProjectId: string): boolean {
    const event = this.journal.event(id);
    return event?.sharedProjectId === sharedProjectId && event.decision === 'denied' && event.classification !== null;
  }
  #context(record: AccessBinding): SharedPeerContext {
    const shared = this.core.sharedProjects.require(record.job.sharedProjectId);
    const {local, remote} = this.core.sharedProjects.endpoints(shared);
    return {shared, local, remote, peerId: record.job.source.project.ownerCoreId, source: record.actor ?? {kind: 'agent', project: record.job.source.project, threadId: record.job.source.threadId, address: record.job.source.address, agent: 'shared agent'}};
  }
  #live(record: AccessBinding): void {
    for (const binding of record.additional ?? []) this.#live(binding);
    const ctx = this.#context(record);
    this.core.sharedProjects.assertActive(ctx.shared);
    const {index} = this.core.sharedProjects.endpoints(ctx.shared);
    if (record.compute) {
      const current = this.core.sharedCompute.journal.get(record.compute.job.id, 'host');
      if (!current || current.stopping || ['revoked', 'cancelled', 'failed', 'uncertain'].includes(current.job.status)) throw refused('shared file policy: job or host consent is closed');
    }
    if (record.board) {
      const entry = this.core.sharedBoard.journal.entry(ctx.shared.id, record.board.cardId);
      const active = this.core.journal.getSetting(`activity:shared:${record.board.threadId}`) as {claimId?: string; sharedProjectId?: string} | null;
      if (!ctx.shared.access[index].board || active?.claimId !== record.board.claimId || active.sharedProjectId !== ctx.shared.id || entry?.kind !== 'card' || entry.card.assignment?.claimId !== record.board.claimId) throw refused('shared file policy: board claim is closed');
    }
    if (record.job.grantRevision !== ctx.shared.access[index].revision) throw refused('shared file policy: job or host consent is closed');
    const worker = this.core.threads.require(record.threadId);
    let checkout: string | undefined;
    try { checkout = realpathSync(worker.cwd); } catch { /* A removed checkout has no current authority. */ }
    if (worker.archived || worker.projectId !== ctx.local.projectId || !record.checkoutPath || checkout !== record.checkoutPath) throw refused('shared file policy: expected the captured job checkout');
  }
  bound(threadId: string): AccessBinding | null {
    const primary = accessBinding(this.core, threadId), letters = letterScope(this.core, threadId).bindings;
    const bindings = [...(primary ? [primary] : []), ...letters];
    return bindings.length ? {...bindings[0]!, additional: bindings.slice(1)} : null;
  }
  #protected(threadId: string): boolean { return this.bound(threadId) !== null || letterScope(this.core, threadId).legacy; }
  assertTurn(threadId: string): void {
    const record = this.bound(threadId);
    if (!this.#protected(threadId)) return;
    if (record) this.#live(record);
    const thread = this.core.threads.require(threadId);
    const protocol = this.core.providers.require(thread.providerId).protocol;
    // Mail outside a shared project holds a native turn even beside a binding,
    // until the owner trusts that history (`threads.trustContactHistory`).
    if (protocol === 'echo' ? thread.permissionMode !== 'default' : !record || letterScope(this.core, threadId).legacy || !this.execution.support(protocol, thread.providerId, thread.permissionMode).supported) this.denyTool(threadId);
  }
  contextThread(thread: ThreadSummary): ThreadSummary { return this.#protected(thread.id) ? {...thread, contextMode: {...TOOL_FREE_CONTEXT}} : thread; }
  assertScope(threadId: string, sharedProjectId: string): void {
    const record = this.bound(threadId);
    if (record && ![record, ...(record.additional ?? [])].some(binding => binding.job.sharedProjectId === sharedProjectId)) throw refused('shared file policy: expected this worker association');
  }
  denyTool(threadId: string): void {
    const record = this.bound(threadId);
    if (!this.#protected(threadId)) return;
    if (record) this.record(this.#context(record), 'tool', 'denied', 'unsupported-tool', null, record.job.id);
    throw refused('shared file policy: this tool has no enforceable shared execution boundary');
  }
  /** Uploaded bytes have no captured host-file identity. Secret uploads must use authorized source publication. */
  uploads(threadId: string, files: {name?: string | null; data: string}[]): void {
    if (!files.length) return;
    if (letterScope(this.core, threadId).legacy) this.denyTool(threadId);
    const record = this.bound(threadId);
    if (!record) return;
    this.#live(record);
    for (const file of files) {
      const name = file.name ?? '';
      const foreign = /[\\/:\x00-\x1f]/.test(name) || /[. ]$/.test(name);
      const classification = foreign ? 'outside-project' : secretPath(name) ?? secretText(Buffer.from(file.data, 'base64').toString('utf8'));
      if (!classification) continue;
      this.record(this.#context(record), 'attachment', 'denied', foreign ? 'path-boundary' : 'secret-content', classification, record.job.id);
      throw refused('shared file policy: secret uploads require publication from an exact authorized host source');
    }
  }
  #rpc(method: RpcMethodName, params: unknown, ctx: RpcContext): void {
    if (ctx.connection.identity.principal !== 'agent') return;
    const id = ctx.connection.identity.threadId;
    const record = id ? this.bound(id) : null;
    const letters = id ? letterScope(this.core, id) : null;
    if (record) this.#live(record);
    if (method === 'collaboration.send' && id && (record || letters?.legacy)) {
      const to = (params as RpcParams<'collaboration.send'>).to;
      const peers = [...(letters?.peers ?? []), ...(record ? [record.job.source.project.ownerCoreId] : [])];
      if (!to || to.coreId === this.core.coordination.card().coreId || !peers.includes(to.coreId)) this.denyTool(id);
      // The normal sender path still checks the exact destination grant/association.
      return;
    }
    if (id && letters?.legacy && !['collaboration.get', 'collaboration.wait', 'threads.capabilities', 'threads.tasks.get', 'threads.tasks.set'].includes(method)) this.denyTool(id);
    if (!record) return;
    if (!WORKER_METHODS.has(method)) this.denyTool(record.threadId);
  }
  #overridesFor(record: AccessBinding, file: PolicyFile, action: FileAction) {
    const current = this.core.sharedProjects.require(record.job.sharedProjectId);
    const {index} = this.core.sharedProjects.endpoints(current);
    return this.journal.overrides(current.id).find(o => o.value.revokedAt === null && o.value.expiresAt > Date.now() && o.value.actions.includes(action)
      && o.value.path === file.path && o.root === record.checkoutPath && o.identity === file.identity && o.revision === current.access[index].revision
      && (o.value.jobId === null || o.value.jobId === record.job.id));
  }
  /** Authorize before opening. Recheck the same inode and consent after awaits and at every ticket use. */
  file(threadId: string, path: string, action: FileAction = 'read', directory = false, quiet = false): SharedFilePermit | undefined {
    if (letterScope(this.core, threadId).legacy) this.denyTool(threadId);
    return this.#fileFor(this.bound(threadId), path, action, directory, quiet);
  }
  #fileFor(record: AccessBinding | null, path: string, action: FileAction, directory = false, quiet = false, content: SharedSecretClass | null = null): SharedFilePermit | undefined {
    if (!record) return undefined;
    this.#live(record);
    const additional = (record.additional ?? []).map(binding => this.#fileFor(binding, path, action, directory, quiet, content)!);
    const ctx = this.#context(record), cwd = this.core.threads.require(record.threadId).cwd;
    let file: PolicyFile;
    const deny = (classification: SharedSecretClass, reason: AccessReason): never => {
      if (!quiet) this.record(ctx, action === 'publish' ? 'attachment' : 'file', 'denied', reason, classification, record.job.id);
      throw refused(`shared file policy: ${classification} requires a current exact host override`, {field: 'path', expected: 'an allowed file in the captured checkout'});
    };
    try { file = policyFile(cwd, path, directory); }
    catch (error) { return deny(error instanceof PolicyPathError ? error.classification : 'outside-project', 'path-boundary'); }
    if (file.classification && !this.#overridesFor(record, file, action)) deny(file.classification, 'secret-file');
    if (content && !this.#overridesFor(record, file, action)) deny(content, 'secret-content');
    if (!quiet) this.record(ctx, action === 'publish' ? 'attachment' : 'file', 'allowed', file.classification ? 'host-override' : 'normal-file', file.classification, record.job.id);
    const check = (): void => {
      for (const permit of additional) permit.check();
      this.#live(record);
      let next: PolicyFile;
      try { next = policyFile(cwd, path, directory); } catch { deny('outside-project', 'path-boundary'); }
      if (content && !this.#overridesFor(record, file, action)) deny(content, 'secret-content');
      if (next!.identity !== file.identity || next!.classification && !this.#overridesFor(record, next!, action)) deny(next!.classification ?? 'outside-project', 'path-boundary');
    };
    return {check, capture: () => {check(); return {path, identity: file.identity, content};}, opened: (real, stats) => {
      check();
      if (policyIdentity(real, stats) !== file.identity) deny('outside-project', 'path-boundary');
    }, inspect: value => {
      for (const permit of additional) permit.inspect(value);
      check();
      content ??= secretText(typeof value === 'string' ? value : Buffer.from(value).toString('utf8'));
      if (content && !this.#overridesFor(record, file, action)) deny(content, 'secret-content');
    }};
  }
  published(threadId: string, messageId: string, permits: (SharedFilePermit | undefined)[]): void {
    const record = this.bound(threadId);
    if (!record) return;
    this.#live(record);
    const files = permits.map(permit => {
      if (!permit?.capture) throw refused('shared file policy: published attachment has no captured source content policy');
      return permit.capture();
    });
    const {compute: _compute, ...binding} = record;
    this.core.journal.setSetting(`shared-publication:${messageId}`, {threadId, binding, files});
  }
  /** Published copies retain their original host scope even after a restart. Unknown pre-policy copies fail closed. */
  publication(threadId: string, messageId: string): SharedFilePermit | undefined {
    const value = this.core.journal.getSetting(`shared-publication:${messageId}`) as Publication | null;
    if (!value && !this.#protected(threadId)) return undefined;
    if (value?.threadId !== threadId || value.binding?.threadId !== threadId || !value.files?.length) throw refused('shared file policy: published attachment has no captured source authority');
    const compute = value.binding.job.id ? this.core.sharedCompute.journal.get(value.binding.job.id, 'host') : undefined;
    if (value.binding.job.id && !compute) throw refused('shared file policy: published job authority is unavailable');
    const record = {...value.binding, ...(compute ? {compute} : {})};
    this.#live(record);
    const permits = value.files.map(file => {
      if (file.content === undefined) throw refused('shared file policy: published attachment has no captured source content policy');
      const permit = this.#fileFor(record, file.path, 'publish', false, false, file.content)!;
      if (policyFile(this.core.threads.require(threadId).cwd, file.path).identity !== file.identity) throw refused('shared file policy: published source changed');
      return permit;
    });
    return {check: () => {for (const permit of permits) permit.check();}, inspect: () => {for (const permit of permits) permit.check();}};
  }
  get(p: RpcParams<'sharedAccess.get'>, connection?: Connection): SharedAccessPage {
    this.assertScope(p.threadId, p.sharedProjectId);
    const shared = this.core.sharedProjects.require(p.sharedProjectId), {local} = this.core.sharedProjects.endpoints(shared);
    if (this.core.threads.require(p.threadId).projectId !== local.projectId) throw refused('threadId: expected a local thread of this audit project');
    if (connection?.identity.principal === 'agent') this.core.sharedProjects.scope(p, connection);
    const after = p.after === undefined ? 0 : typeof p.after === 'string' ? this.journal.cursor(shared.id, p.after) : null;
    if (after === null) throw invalidParams('after: expected an event cursor of this association');
    const page = this.journal.page(p.sharedProjectId, after);
    return {...page, verdicts: this.core.sharedReview.journal.verdicts(shared.id, page.events.map(event => event.id))};
  }
  #owner(id: string) {
    const shared = this.core.sharedProjects.require(id);
    const {local} = this.core.sharedProjects.endpoints(shared);
    return {shared, source: {kind: 'human', project: local} as const};
  }
  overrides(id: string): SharedFileOverride[] { this.#owner(id); return this.journal.overrides(id).map(o => o.value); }
  activeOverrides(id: string): number {
    const shared = this.core.sharedProjects.require(id), {index} = this.core.sharedProjects.endpoints(shared);
    if (shared.state !== 'active') return 0;
    return this.journal.overrides(id).filter(o => {
      if (o.value.revokedAt !== null || o.value.expiresAt <= Date.now() || o.revision !== shared.access[index].revision) return false;
      try { return policyFile(o.root, o.value.path).identity === o.identity; } catch { return false; }
    }).length;
  }
  override(p: RpcParams<'sharedAccess.override'>): SharedFileOverride {
    const ctx = this.#owner(p.sharedProjectId); this.core.sharedProjects.assertActive(ctx.shared);
    const input = p.override;
    if (!input || Object.keys(input).some(k => !['path', 'actions', 'jobId', 'reason', 'expiresAt'].includes(k))) throw invalidParams('override: expected path, actions, jobId, reason and expiresAt');
    if (!Array.isArray(input.actions) || !input.actions.length || new Set(input.actions).size !== input.actions.length || input.actions.some(a => a !== 'read' && a !== 'publish')) throw invalidParams('override.actions: expected read or publish; execute has no selective isolation boundary');
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now()) throw invalidParams('override.expiresAt: expected a future timestamp');
    const reason = text(input.reason, 'override.reason', 500), path = text(input.path, 'override.path', 4096);
    const {local, index} = this.core.sharedProjects.endpoints(ctx.shared);
    const record = input.jobId === null ? null : this.core.sharedCompute.journal.get(text(input.jobId, 'override.jobId', 100), 'host');
    if (input.jobId !== null && (!record || record.job.sharedProjectId !== ctx.shared.id || !record.checkoutPath)) throw refused('override.jobId: expected a captured job of this association on this host');
    const root = record?.checkoutPath ?? realpathSync(this.core.projects.require(local.projectId).path);
    let file: PolicyFile;
    try { file = policyFile(root, path); } catch { throw refused('shared file policy: override.path must be an existing exact file inside the selected host checkout'); }
    const requestId = text(p.requestId, 'requestId', 100);
    const result = this.core.sharedProjects.journal.transaction(() => this.core.sharedProjects.journal.once(`file-override:${ctx.shared.id}`, requestId, p, () => {
      const value: SharedFileOverride = {id: `sfo_${randomUUID()}`, sharedProjectId: ctx.shared.id, path: file.path, actions: [...input.actions], jobId: input.jobId, reason, expiresAt: input.expiresAt, revokedAt: null};
      this.journal.putOverride({value, root, identity: file.identity, revision: ctx.shared.access[index].revision});
      this.record(ctx, 'file', 'allowed', 'override-created');
      return value.id;
    }));
    this.core.sharedProjects.notify(ctx.shared.id);
    this.execution.reconcile();
    return this.overrides(ctx.shared.id).find(o => o.id === result)!;
  }
  revokeOverride(p: RpcParams<'sharedAccess.revokeOverride'>): {ok: true} {
    const ctx = this.#owner(p.sharedProjectId);
    const found = this.journal.overrides(ctx.shared.id).find(o => o.value.id === p.overrideId);
    if (!found) throw refused('overrideId: expected a host override of this association');
    if (found.value.revokedAt === null) {
      found.value.revokedAt = Date.now(); this.journal.putOverride(found);
      this.record(ctx, 'file', 'allowed', 'override-revoked'); this.core.sharedProjects.notify(ctx.shared.id);
      this.execution.reconcile();
    }
    return {ok: true};
  }
}

export function registerSharedAccess(core: Core): void {
  core.router.register('sharedAccess.get', (p, c) => core.sharedAccess.get(p, c.connection));
  core.router.register('sharedAccess.reviewConfig', p => core.sharedReview.config(p.sharedProjectId));
  core.router.register('sharedAccess.overrides', p => core.sharedAccess.overrides(p.sharedProjectId));
  core.router.register('sharedAccess.override', p => core.sharedAccess.override(p));
  core.router.register('sharedAccess.revokeOverride', p => core.sharedAccess.revokeOverride(p));
}
