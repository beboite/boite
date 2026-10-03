import { stat } from 'node:fs/promises';
import { ATTENTION_IDLE_MS, ATTENTION_LEASE_MS, protectedThreadIdsError, type ThreadId } from '@boite/contracts';
import type { Core } from '../core.ts';
import { assertDriverRunnable, getDriver, setThreadViewed } from '../drivers/index.ts';
import { invalidParams } from '../errors.ts';
import { logMessageOf } from '../log-errors.ts';

/** A `threads.focus` report as push sees it: the thread shown, and when the user last used it while watching. */
export interface AttentionReport { threadId: ThreadId | null; activeAt: number | null }

/** One visible conversation per socket. Preparation never participates in turn admission. */
export class ThreadFocus {
  private readonly viewers = new Map<string, ThreadId>();
  private readonly protectedInputs = new Map<string, Set<ThreadId>>();
  private readonly protectAll = new Set<string>();
  private readonly inputReports = new Set<string>();
  private readonly prepared = new Map<ThreadId, { key: string; pending: boolean }>();
  /** Per connection, the thread its user is looking at and until when the core believes it (`ATTENTION_LEASE_MS`). */
  private readonly attention = new Map<string, { threadId: ThreadId; until: number }>();
  private readonly attentionListeners = new Set<(report: AttentionReport) => void>();
  private readonly unlisten: () => void;
  private closed = false;

  constructor(private readonly core: Core) {
    this.unlisten = core.bus.onCommitted((name, payload) => {
      if (name === 'thread.updated') {
        this.refresh((payload as { id: ThreadId }).id);
      } else if (name === 'thread.removed') {
        const threadId = (payload as { threadId: ThreadId }).threadId;
        setThreadViewed(threadId, false);
        this.prepared.delete(threadId);
        for (const ids of this.protectedInputs.values()) ids.delete(threadId);
        for (const [connectionId, viewed] of this.viewers) {
          if (viewed === threadId) this.viewers.delete(connectionId);
        }
      }
    });
  }

  set(connectionId: string, threadId: ThreadId | null, protectedThreadIds?: ThreadId[], protectAllThreads?: boolean, attentive?: boolean, idleMs?: number): void {
    if (threadId !== null && (typeof threadId !== 'string' || threadId.length === 0)) {
      throw invalidParams('threadId must be a nonempty thread id or null', { field: 'threadId' });
    }
    if (attentive !== undefined && typeof attentive !== 'boolean') {
      throw invalidParams('attentive must be a boolean', { field: 'attentive', expected: 'boolean' });
    }
    if (idleMs !== undefined && (typeof idleMs !== 'number' || !Number.isFinite(idleMs) || idleMs < 0)) {
      throw invalidParams('idleMs must be a nonnegative number of milliseconds', { field: 'idleMs', expected: 'a finite number >= 0' });
    }
    const protectionError = protectedThreadIdsError(protectedThreadIds);
    if (protectionError) throw invalidParams(protectionError, { field: 'protectedThreadIds', expected: 'at most 256 nonempty thread ids' });
    if (protectAllThreads !== undefined && typeof protectAllThreads !== 'boolean') {
      throw invalidParams('protectAllThreads must be a boolean', { field: 'protectAllThreads', expected: 'boolean' });
    }
    if (this.closed || this.core.stopping) return;
    if (threadId !== null) this.core.threads.require(threadId);
    // Older UIs clear parked input on archive events but cannot report it.
    if (!this.inputReports.has(connectionId)) {
      if (protectedThreadIds !== undefined || protectAllThreads !== undefined) {
        this.inputReports.add(connectionId);
        this.protectAll.delete(connectionId);
      } else this.protectAll.add(connectionId);
    }
    if (protectedThreadIds !== undefined) {
      if (protectedThreadIds.length) this.protectedInputs.set(connectionId, new Set(protectedThreadIds));
      else this.protectedInputs.delete(connectionId);
    }
    if (protectAllThreads === true) this.protectAll.add(connectionId);
    else if (protectAllThreads === false) this.protectAll.delete(connectionId);
    this.attend(connectionId, threadId, attentive === true, idleMs);
    const previous = this.viewers.get(connectionId);
    if (threadId === null) this.viewers.delete(connectionId);
    else this.viewers.set(connectionId, threadId);
    if (previous && previous !== threadId && !this.viewed(previous)) {
      setThreadViewed(previous, false);
      this.prepared.delete(previous);
    }
    if (threadId !== null) this.refresh(threadId);
  }

  disconnect(connectionId: string): void {
    this.set(connectionId, null, [], false);
    this.inputReports.delete(connectionId);
  }

  viewed(threadId: ThreadId): boolean {
    return [...this.viewers.values()].includes(threadId);
  }

  /**
   * Until when someone counts as looking at the thread on one of their
   * clients, or 0: push about it would only repeat what the screen shows.
   */
  attendedUntil(threadId: ThreadId): number {
    const now = Date.now();
    let until = 0;
    for (const [connectionId, lease] of this.attention) {
      if (lease.until <= now) this.attention.delete(connectionId);
      else if (lease.threadId === threadId) until = Math.max(until, lease.until);
    }
    return until;
  }

  attended(threadId: ThreadId): boolean { return this.attendedUntil(threadId) > 0; }

  /** Hears every report once the core has taken it in, and every disconnection as a report of nothing. */
  onAttention(listener: (report: AttentionReport) => void): () => void {
    this.attentionListeners.add(listener);
    return () => this.attentionListeners.delete(listener);
  }

  /**
   * An attentive report renews the connection's lease; any other ends it at
   * once. A page left alone past `ATTENTION_IDLE_MS` is not believed, whatever
   * it says.
   */
  private attend(connectionId: string, threadId: ThreadId | null, attentive: boolean, idleMs: number | undefined): void {
    const now = Date.now();
    if (attentive && threadId !== null && (idleMs === undefined || idleMs < ATTENTION_IDLE_MS)) {
      this.attention.set(connectionId, { threadId, until: now + ATTENTION_LEASE_MS });
    } else this.attention.delete(connectionId);
    const report = { threadId, activeAt: idleMs === undefined || threadId === null ? null : now - idleMs };
    for (const listener of this.attentionListeners) listener(report);
  }

  hasProtectedInput(threadId: ThreadId): boolean {
    if (this.protectAll.size) return true;
    for (const ids of this.protectedInputs.values()) if (ids.has(threadId)) return true;
    return false;
  }

  private refresh(threadId: ThreadId): void {
    if (this.closed || this.core.stopping || !this.viewed(threadId)) return;
    const thread = this.core.journal.getThread(threadId);
    if (!thread || thread.archived || thread.agentSessionId) {
      setThreadViewed(threadId, false);
      this.prepared.delete(threadId);
      return;
    }
    setThreadViewed(threadId, true);
    if (['running', 'queued', 'waiting'].includes(thread.status)) return;
    const key = JSON.stringify([thread.providerId, thread.accountId, thread.selectionVersion, thread.sessionGeneration, thread.cwd, thread.sessionResumeAt]);
    const previous = this.prepared.get(threadId);
    if (previous?.pending || previous?.key === key) return;
    const entry = { key, pending: true };
    this.prepared.set(threadId, entry);
    void this.prepare(threadId).catch(error => {
      this.core.log('warn', `preparing the visible conversation failed: ${logMessageOf(error)}`, { source: thread.providerId, event: 'provider.prepareFailed', threadId });
    }).finally(() => {
      entry.pending = false;
      if (this.closed || this.core.stopping || !this.viewed(threadId) || this.core.journal.getThread(threadId)?.archived !== false) setThreadViewed(threadId, false);
      else if (this.prepared.get(threadId) === entry) this.refresh(threadId);
    });
  }

  private async prepare(threadId: ThreadId): Promise<void> {
    const thread = this.core.threads.require(threadId);
    const provider = this.core.providers.require(thread.providerId);
    const driver = getDriver(provider.protocol);
    if (!driver.prepare || this.core.plugins.blocksAccount(thread.accountId)) return;
    const account = this.core.accounts.require(thread.accountId);
    assertDriverRunnable(provider.protocol, this.core.providers.list().loaded.find(item => item.id === provider.id), account);
    if (!await stat(thread.cwd).then(value => value.isDirectory(), () => false)) return;
    if (this.closed || this.core.stopping || !this.viewed(threadId)) return;
    const latest = this.core.threads.require(threadId);
    if (latest.selectionVersion !== thread.selectionVersion || latest.sessionGeneration !== thread.sessionGeneration || latest.archived) return;
    if (['running', 'queued', 'waiting'].includes(latest.status)) return;
    await driver.prepare(this.core.threads.contexts.makeSessionContext(thread, provider, account));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlisten();
    for (const threadId of new Set(this.viewers.values())) setThreadViewed(threadId, false);
    this.viewers.clear();
    this.protectedInputs.clear();
    this.protectAll.clear();
    this.inputReports.clear();
    this.prepared.clear();
    this.attention.clear();
    this.attentionListeners.clear();
  }
}
