import { stat } from 'node:fs/promises';
import type { Project, RpcParams, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable, getDriver, releaseThread, setThreadViewed } from '../drivers/index.ts';
import type { SessionContext } from '../drivers/types.ts';
import { invalidParams, refused } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';
import { titleOf } from './inputs.ts';
import { DraftReservationLedger, type DraftOwnership } from './draft-reservation-ledger.ts';

type Params = RpcParams<'drafts.prepare'>;
const LIFETIME_MS = 10 * 60_000;
const CONNECTION_BACKLOG = 4;
const GLOBAL_BACKLOG = 32;
interface Reservation {
  connectionId: string;
  ownership: DraftOwnership | null;
  traceId: string | null;
  id: string;
  key: string;
  project: Project;
  params: Params;
  planned: Promise<ThreadSummary>;
  thread: ThreadSummary | null;
  cancelled: boolean;
  adopted: boolean;
  timer: ReturnType<typeof setTimeout>;
  flush: () => void;
}

/** One invisible workspace and native session per composing connection. */
export class DraftPreparations {
  readonly #entries = new Map<string, Reservation>();
  readonly #cleanups = new Set<Promise<void>>();
  readonly #released = new Map<string, Map<string, number>>();
  readonly #receipts = new Map<string, { id: string; key: string; threadId: string; expiresAt: number }>();
  readonly #backlog = new Set<Reservation>();
  /** Discarded drafts whose processes were told to stop and may not have exited yet. */
  readonly #stopping = new Map<string, ThreadSummary>();
  readonly #ledger: DraftReservationLedger;
  #readiness: Promise<void> | null = null;
  readonly #pending = new Map<string, Set<{ cancelled: boolean }>>();
  #closed = false;

  readonly #core: Core;
  constructor(core: Core) {
    this.#core = core;
    this.#ledger = new DraftReservationLedger(core);
  }

  /** Folders a draft reserved or is cleaning up: the worktree cleanup leaves them alone. */
  reservedPaths(): string[] {
    const live = [...this.#entries.values(), ...this.#backlog].flatMap(entry => entry.ownership ? [entry.ownership.path] : []);
    return [...new Set([...this.#ledger.list().map(ownership => ownership.path), ...live])];
  }

  /**
   * The threads of drafts not adopted yet, which no list holds: a worktree
   * removal counts their processes. A discarded one stays until they exited.
   */
  threads(): ThreadSummary[] {
    this.#forgetStopped();
    const pending = [...this.#entries.values(), ...this.#backlog].flatMap(entry => entry.thread && !entry.adopted ? [entry.thread] : []);
    return [...new Map([...pending, ...this.#stopping.values()].map(thread => [thread.id, thread])).values()];
  }

  /** Startup and speculative admission share one reconciliation barrier. */
  recover(): Promise<void> { return this.#readiness ??= this.#ledger.recover(); }

  catalogThread(providerId: string, accountId: string): ThreadSummary | undefined {
    return [...this.#entries.values()].find(entry => !entry.cancelled && entry.thread?.providerId === providerId && entry.thread.accountId === accountId)?.thread ?? undefined;
  }

  async prepare(connectionId: string, params: Params): Promise<{ preparationId: string; threadId: string }> {
    this.#checkId(params.preparationId);
    const token = { cancelled: false };
    const waiting = this.#pending.get(connectionId) ?? new Set<{ cancelled: boolean }>();
    waiting.add(token);
    this.#pending.set(connectionId, waiting);
    try {
      await this.recover();
      if (token.cancelled) throw refused('draft preparation connection was closed');
      return await this.#prepareReady(connectionId, params);
    } finally {
      waiting.delete(token);
      if (!waiting.size) this.#pending.delete(connectionId);
    }
  }

  async #prepareReady(connectionId: string, params: Params): Promise<{ preparationId: string; threadId: string }> {
    if (this.#closed || this.#core.stopping) throw refused('the core is stopping');
    const released = this.#released.get(connectionId);
    if (released?.has(params.preparationId)) throw refused('draft preparation was released', { reason: 'draft-preparation-expired' });
    const key = creationKey(params);
    const previous = this.#entries.get(connectionId);
    if (previous?.id === params.preparationId) {
      if (previous.key !== key) throw refused('preparationId was already used for another selection');
      const thread = await previous.planned;
      if (previous.cancelled) throw refused('draft preparation was released', { reason: 'draft-preparation-expired' });
      return { preparationId: previous.id, threadId: thread.id };
    }
    const creation = this.#core.threads.creation;
    creation.validate(params);
    const project = this.#core.projects.require(params.projectId);
    this.#admit(connectionId);
    if (previous) void this.release(connectionId, previous.id).catch(error => this.#core.log('warn', `draft cleanup failed: ${logMessageOf(error)}`));
    const entry: Reservation = {
      connectionId, ownership: null, traceId: null,
      id: params.preparationId, key, project, params, thread: null, cancelled: false, adopted: false,
      planned: Promise.resolve(null as unknown as ThreadSummary), flush: () => undefined,
      timer: setTimeout(() => { void this.release(connectionId, params.preparationId).catch(error => this.#core.log('warn', `draft cleanup failed: ${logMessageOf(error)}`)); }, LIFETIME_MS),
    };
    entry.timer.unref?.();
    this.#entries.set(connectionId, entry);
    this.#backlog.add(entry);
    entry.planned = this.#plan(entry);
    try {
      const thread = await entry.planned;
      if (entry.cancelled || this.#closed || this.#core.stopping) throw refused('draft preparation was released', { reason: 'draft-preparation-expired' });
      return { preparationId: entry.id, threadId: thread.id };
    } catch (error) {
      // Replacement/disconnect already owns cleanup. Do not recreate its cleared tombstone.
      if (this.#entries.get(connectionId) === entry) await this.release(connectionId, entry.id);
      throw error;
    }
  }

  async claim(connectionId: string, params: RpcParams<'threads.create'>): Promise<ThreadSummary | null> {
    if (params.preparationId === undefined) return null;
    this.#checkId(params.preparationId);
    const entry = this.#entries.get(connectionId);
    // Reconnects, expired leases and abandoned preparations take the ordinary creation path.
    if (!entry || entry.id !== params.preparationId || entry.cancelled) {
      const receipt = this.#receipts.get(connectionId);
      return receipt?.id === params.preparationId && receipt.key === creationKey(params) && receipt.expiresAt > Date.now()
        ? this.#core.journal.getThread(receipt.threadId) : null;
    }
    if (entry.key !== creationKey(params)) throw refused('draft preparation does not match this conversation selection', { reason: 'draft-preparation-mismatch' });
    const thread = await entry.planned;
    if (entry.adopted) return this.#core.journal.getThread(thread.id);
    if (entry.cancelled || this.#closed || this.#entries.get(connectionId) !== entry) return null;
    this.#core.threads.creation.validate(params);
    if (!await stat(thread.cwd).then(found => found.isDirectory(), () => false)) throw refused('the prepared draft folder no longer exists', { field: 'cwd', reason: 'draft-preparation-expired' });
    if (entry.adopted) return this.#core.journal.getThread(thread.id);
    if (entry.cancelled || this.#closed || this.#entries.get(connectionId) !== entry) return null;
    const now = Date.now();
    const created = this.#core.threads.creation.publish({ ...thread, title: titleOf(params.title), createdAt: now, updatedAt: now });
    entry.adopted = true;
    // The durable thread has been committed. Recovery also checks it if this clear fails.
    try { this.#ledger.forget(thread.id); } catch (error) { this.#core.log('warn', `draft ownership retained after adoption: ${logMessageOf(error)}`); }
    this.#backlog.delete(entry);
    this.#receipts.set(connectionId, { id: entry.id, key: entry.key, threadId: created.id, expiresAt: Date.now() + LIFETIME_MS });
    this.#entries.delete(connectionId);
    clearTimeout(entry.timer);
    entry.flush();
    // Transfer retention to ordinary focus, with the driver's navigation grace until the client focuses it.
    setThreadViewed(thread.id, false);
    return created;
  }

  async release(connectionId: string, preparationId: string): Promise<void> {
    this.#checkId(preparationId);
    const released = this.#released.get(connectionId) ?? new Map<string, number>();
    for (const [id, until] of released) if (until <= Date.now()) released.delete(id);
    if (released.size >= 32) released.delete(released.keys().next().value!);
    released.set(preparationId, Date.now() + LIFETIME_MS);
    this.#released.set(connectionId, released);
    const entry = this.#entries.get(connectionId);
    if (!entry || entry.id !== preparationId) return;
    this.#entries.delete(connectionId);
    entry.cancelled = true;
    clearTimeout(entry.timer);
    if (entry.thread) this.#stop(entry.thread);
    else if (entry.traceId) this.#core.procs.killTree(entry.traceId);
    const cleanup = entry.planned.then(() => this.#cleanup(entry), () => this.#cleanup(entry));
    this.#cleanups.add(cleanup);
    try { await cleanup; } finally { this.#cleanups.delete(cleanup); }
  }

  async disconnect(connectionId: string): Promise<void> {
    for (const token of this.#pending.get(connectionId) ?? []) token.cancelled = true;
    const entry = this.#entries.get(connectionId);
    try { if (entry) await this.release(connectionId, entry.id); }
    finally {
      this.#released.delete(connectionId);
      this.#receipts.delete(connectionId);
      // Failed cleanup intent remains durable, without retaining a disconnected connection.
      for (const queued of this.#backlog) if (queued.connectionId === connectionId) queued.connectionId = '';
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.recover();
    await Promise.all([...this.#entries.keys()].map(id => this.disconnect(id)));
    await Promise.all(this.#cleanups);
    this.#released.clear();
    this.#receipts.clear();
  }

  async #plan(entry: Reservation): Promise<ThreadSummary> {
    await this.#core.projects.requireFolder(entry.project.id);
    if (entry.cancelled || this.#closed || this.#core.stopping) throw refused('draft preparation was released');
    const creation = this.#core.threads.creation;
    const beforeMutation = (ownership: DraftOwnership) => {
      if (entry.cancelled || this.#closed || this.#core.stopping) throw refused('draft preparation was released');
      entry.ownership = ownership;
      return this.#ledger.record(ownership);
    };
    beforeMutation.assertActive = (threadId: string) => {
      entry.traceId = threadId;
      if (entry.cancelled || this.#closed || this.#core.stopping) throw refused('draft preparation was released');
    };
    const thread = entry.params.worktree ? await creation.createInWorktree(entry.params, false, beforeMutation) : creation.create(entry.params, undefined, false, beforeMutation);
    entry.thread = thread;
    if (!entry.cancelled && !this.#closed) {
      try { this.#prepareSession(entry, thread); }
      catch (error) { this.#core.log('warn', `preparing a draft failed: ${logMessageOf(error)}`, { source: thread.providerId, event: 'provider.prepareFailed', threadId: thread.id }); }
    }
    return thread;
  }

  #prepareSession(entry: Reservation, thread: ThreadSummary): void {
    const provider = this.#core.providers.require(thread.providerId);
    const account = this.#core.accounts.require(thread.accountId);
    const driver = getDriver(provider.protocol);
    if (!driver.prepare || this.#core.plugins.blocksAccount(account.id)) return;
    assertDriverRunnable(provider.protocol, this.#core.providers.summary(provider.id), account);
    const context = this.#core.threads.contexts.makeSessionContext(thread, provider, account);
    // Setup can report commands/context before there is a journal record. Buffer those until adoption.
    const buffered: { field: keyof SessionContext; args: unknown[] }[] = [];
    let overflowLogged = false;
    for (const field of ['commands', 'context', 'background', 'backgroundFinished', 'hook'] as const) {
      const callback = context[field];
      if (!callback) continue;
      Object.assign(context, { [field]: (...args: unknown[]) => {
        if (entry.cancelled) return;
        if (entry.adopted) (callback as (...args: unknown[]) => void)(...args);
        else {
          if (field === 'commands' || field === 'context' || field === 'background') {
            const previous = buffered.findIndex(item => item.field === field);
            if (previous >= 0) buffered.splice(previous, 1);
          }
          if (buffered.length >= 128) {
            buffered.shift();
            if (!overflowLogged) this.#core.log('warn', 'draft preparation metadata buffer reached 128 reports', { threadId: thread.id });
            overflowLogged = true;
          }
          buffered.push({ field, args });
        }
      } });
    }
    entry.flush = () => {
      for (const { field, args } of buffered) {
        const live = this.#core.threads.contexts.makeSessionContext(thread, provider, account)[field];
        if (typeof live === 'function') (live as (...args: unknown[]) => void)(...(args as unknown[]));
      }
      buffered.length = 0;
    };
    // A setup still running once the draft is discarded starts nothing more, so its stop really ends (`threads`).
    const spawnChild = context.spawnChild;
    context.spawnChild = (...args) => {
      if (entry.cancelled) throw refused('draft preparation was released', { reason: 'draft-preparation-expired' });
      return spawnChild(...args);
    };
    setThreadViewed(thread.id, true);
    void driver.prepare(context).catch(error => {
      if (!entry.cancelled) this.#core.log('warn', `preparing a draft failed: ${logMessageOf(error)}`, { source: provider.id, event: 'provider.prepareFailed', threadId: thread.id });
    });
  }

  #stop(thread: ThreadSummary): void {
    setThreadViewed(thread.id, false);
    releaseThread(thread.id);
    this.#core.procs.killTree(thread.id);
    this.#core.agents.forget(thread.id);
    this.#forgetStopped();
    this.#stopping.set(thread.id, thread);
  }

  #forgetStopped(): void {
    for (const id of this.#stopping.keys()) if (this.#core.procs.liveCount(id as ThreadId) === 0) this.#stopping.delete(id);
  }

  async #cleanup(entry: Reservation): Promise<void> {
    if (entry.adopted) return;
    if (entry.thread) this.#stop(entry.thread);
    if (!entry.ownership || await this.#ledger.cleanup(entry.ownership)) this.#backlog.delete(entry);
    if (entry.thread) this.#core.agents.forget(entry.thread.id);
  }

  #admit(connectionId: string): void {
    const recorded = new Set([...this.#backlog].flatMap(entry => entry.ownership ? [entry.ownership.threadId] : []));
    const retained = this.#ledger.list().filter(item => !recorded.has(item.threadId)).length;
    if (this.#backlog.size + retained >= GLOBAL_BACKLOG || [...this.#backlog].filter(entry => entry.connectionId === connectionId).length >= CONNECTION_BACKLOG) {
      throw refused('draft preparation cleanup backlog is full; send can create a conversation normally', { reason: 'draft-preparation-capacity' });
    }
  }

  #checkId(id: string): void {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw invalidParams('preparationId: expected 8 to 128 URL-safe characters');
  }
}

function creationKey(params: RpcParams<'threads.create'>): string {
  return JSON.stringify([params.projectId, params.providerId, params.accountId, params.model ?? null, params.effort ?? null, params.speed ?? null,
    params.permissionMode ?? 'default', params.cwd ?? null, params.worktree ? [params.worktree.branch ?? null] : null, params.incognito === true, params.context ?? null]);
}
