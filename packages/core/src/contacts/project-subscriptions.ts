/** Connection-owned local watches and expiring peer leases. No global foreign thread stream. */
import { randomUUID } from 'node:crypto';
import type { RpcParams, SharedProjectPeerMethods, SharedProjectScope } from '@boite/contracts';
import type { Connection } from '../router.ts';
import { text } from '../coordination-letter.ts';
import { invalidParams, refused } from '../errors.ts';
import type { SharedPeerContext, SharedProjects } from './projects.ts';

const LEASE_MS = 60_000;
const RENEW_MS = 20_000;
type Kind = 'threads' | 'board' | 'compute' | 'access';
interface Watch { id: string; connection: Connection; scope: SharedProjectScope; context: SharedPeerContext; off?: () => void }
interface Lease { id: string; context: SharedPeerContext; expiresAt: number }

export class SharedProjectSubscriptions {
  readonly #watches = new Map<string, Watch>();
  private readonly leases = new Map<string, Lease>();
  /** A delayed enable must not recreate a lease after disable won. Covers the wire replay window. */
  readonly #cancelled = new Map<string, number>();
  readonly #dirty = new Map<string, Set<Kind>>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #links = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  #coalescer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;
  readonly #service: SharedProjects;
  constructor(service: SharedProjects) {
    this.#service = service;}

  #key(connection: Connection, p: SharedProjectScope): string { return JSON.stringify([connection.id, p.threadId, p.sharedProjectId]); }
  #background(work: Promise<unknown>): void {
    this.#pending.add(work);
    void work.catch(() => undefined).finally(() => this.#pending.delete(work));
  }
  #arm(): void {
    if (this.timer || this.#closed || (this.#watches.size === 0 && this.leases.size === 0)) return;
    this.timer = setInterval(() => this.#tick(), RENEW_MS);
    this.timer.unref?.();
  }
  #disarm(): void {
    if (this.#watches.size || this.leases.size) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  async #renew(watch: Watch, enabled: boolean): Promise<void> {
    // Closing retains the admitted source identity, including after disconnect,
    // but must use current policy rather than the last enable's revision.
    const shared = this.#service.require(watch.scope.sharedProjectId);
    const ctx = enabled ? this.#service.scope(watch.scope, watch.connection) : {...watch.context, shared, ...this.#service.endpoints(shared)};
    if (enabled) watch.context = ctx;
    await this.#service.request(ctx, 'subscribe', { subscriptionId: watch.id, enabled, leaseMs: LEASE_MS });
  }
  async subscribe(p: RpcParams<'sharedProjects.subscribe'>, connection: Connection): Promise<{ ok: true }> {
    if (typeof p.enabled !== 'boolean') throw invalidParams('enabled: expected a boolean');
    const key = this.#key(connection, p);
    const existing = this.#watches.get(key);
    if (!p.enabled) {
      if (existing) { this.#remove(key); this.#background(this.#renew(existing, false)); }
      return { ok: true };
    }
    const context = this.#service.scope(p, connection);
    const watch: Watch = existing ?? { id: randomUUID(), connection, context, scope: { threadId: p.threadId, sharedProjectId: p.sharedProjectId } };
    if (!existing) {
      this.#watches.set(key, watch);
      const off = connection.onClose?.(() => this.disconnect(connection.id));
      if (off) watch.off = off;
    }
    this.#arm();
    // Offline is recoverable: renew only while this live connection still owns the watch.
    try { await this.#renew(watch, true); } catch { /* The next lease tick retries under current permissions. */ }
    if (this.#watches.get(key) === watch) {
      try { this.#service.scope(p, connection); }
      catch (error) { this.#remove(key); throw error; }
    }
    return { ok: true };
  }
  disconnect(connectionId: string): void {
    for (const [key, watch] of this.#watches) if (watch.connection.id === connectionId) {
      this.#remove(key);
      if (!this.#closed) this.#background(this.#renew(watch, false));
    }
  }
  #remove(key: string): void {
    const watch = this.#watches.get(key);
    if (!watch) return;
    this.#watches.delete(key);
    watch.off?.();
    this.#disarm();
  }
  receiveSubscribe(ctx: SharedPeerContext, p: SharedProjectPeerMethods['subscribe']['params']): { expiresAt: number } {
    const id = text(p?.subscriptionId, 'subscriptionId', 100);
    if (typeof p.enabled !== 'boolean' || !Number.isSafeInteger(p.leaseMs) || p.leaseMs < 1000 || p.leaseMs > LEASE_MS) throw invalidParams('subscribe: expected enabled and leaseMs from 1000 to 60000');
    const key = JSON.stringify([ctx.peerId, id]);
    const now = Date.now();
    for (const [closed, until] of this.#cancelled) if (until <= now) this.#cancelled.delete(closed);
    if (p.enabled && this.#cancelled.has(key)) throw refused('subscriptionId: this subscription was closed');
    const existing = this.leases.get(key);
    if (existing && (existing.context.shared.id !== ctx.shared.id || JSON.stringify(existing.context.source) !== JSON.stringify(ctx.source))) throw refused('subscriptionId: already bound to another source');
    const expiresAt = p.enabled ? Date.now() + p.leaseMs : Date.now();
    if (p.enabled) this.leases.set(key, { id, context: ctx, expiresAt });
    else { this.leases.delete(key); this.#cancelled.set(key, now + 120_000); }
    this.#arm(); this.#disarm();
    return { expiresAt };
  }
  async receiveChanged(ctx: SharedPeerContext, p: SharedProjectPeerMethods['changed']['params']): Promise<{ ok: true }> {
    if (p?.subscriptionId === null && p.kinds?.length === 1 && p.kinds[0] === 'compute') {
      await this.#service.core.sharedCompute.receiveChanged(ctx, p.jobIds!);
      return {ok: true};
    }
    const id = text(p?.subscriptionId, 'subscriptionId', 100);
    if (!Array.isArray(p.kinds) || p.kinds.length > 4 || p.kinds.some(k => !['threads', 'board', 'compute', 'access'].includes(k))) throw invalidParams('changed.kinds: expected threads, board, compute or access');
    const found = [...this.#watches.values()].filter(w => w.id === id && w.scope.sharedProjectId === ctx.shared.id);
    if (!found.length) throw refused('subscriptionId: expected a live local subscription');
    for (const watch of found) this.#deliver(watch, p.kinds);
    return { ok: true };
  }
  #deliver(watch: Watch, kinds: Kind[] = ['threads', 'board', 'compute', 'access']): void {
    const key = this.#key(watch.connection, watch.scope);
    if (!this.#watches.has(key) || this.#closed) return;
    try { this.#service.scope(watch.scope, watch.connection); }
    catch {
      // The last invalidation lets this exact view discard its data, then its subscription ends.
      watch.connection.sendEvent('sharedProjects.changed', {...watch.scope, kinds: ['threads', 'board', 'compute', 'access']});
      this.#remove(key);
      this.#background(this.#renew(watch, false));
      return;
    }
    watch.connection.sendEvent('sharedProjects.changed', {...watch.scope, kinds});
  }
  changed(id: string, kinds: Kind[]): void {
    if (this.#closed) return;
    if (![...this.#watches.values()].some(w => w.scope.sharedProjectId === id) && ![...this.leases.values()].some(l => l.context.shared.id === id)) return;
    const pending = this.#dirty.get(id) ?? new Set<Kind>();
    for (const kind of kinds) pending.add(kind);
    this.#dirty.set(id, pending);
    if (this.#coalescer === null) {
      this.#coalescer = setTimeout(() => { this.#coalescer = null; this.#flush(); }, 50);
      this.#coalescer.unref?.();
    }
  }
  invalidateAll(): void {
    for (const watch of this.#watches.values()) this.changed(watch.scope.sharedProjectId, ['threads', 'board', 'compute', 'access']);
  }
  sourceChanged(threadId: string): void {
    for (const watch of this.#watches.values()) if (watch.scope.threadId === threadId) {
      try { this.#service.scope(watch.scope, watch.connection); }
      catch { this.#deliver(watch); }
    }
  }
  contactChanged(): void {
    for (const contact of this.#service.core.contacts.peers()) {
      const connected = this.#service.core.contacts.linkOf(contact.coreId) === 'connected';
      const before = this.#links.get(contact.coreId) ?? false;
      this.#links.set(contact.coreId, connected);
      if (!connected) for (const [key, lease] of this.leases) if (lease.context.peerId === contact.coreId) this.leases.delete(key);
      if (connected && !before) for (const watch of this.#watches.values()) if (watch.context.peerId === contact.coreId) {
        this.#deliver(watch); this.#background(this.#renew(watch, true));
      }
    }
    for (const [key, lease] of this.leases) if (!this.#service.core.contacts.isContact(lease.context.peerId)) this.leases.delete(key);
    this.#disarm();
  }
  #flush(): void {
    const dirty = [...this.#dirty]; this.#dirty.clear();
    for (const [id, kinds] of dirty) {
      for (const watch of this.#watches.values()) if (watch.scope.sharedProjectId === id) this.#deliver(watch, [...kinds]);
      for (const [key, lease] of this.leases) if (lease.context.shared.id === id) {
        const shared = this.#service.require(id);
        if (lease.expiresAt <= Date.now() || shared.state !== 'active') { this.leases.delete(key); continue; }
        const { local, remote } = this.#service.endpoints(shared);
        this.#background(this.#service.request({ shared, local, remote, peerId: remote.ownerCoreId, source: { kind: 'human', project: local } }, 'changed', { subscriptionId: lease.id, kinds: [...kinds] }));
      }
    }
    this.#disarm();
  }
  #tick(): void {
    for (const [key, lease] of this.leases) {
      try { this.#service.assertActive(this.#service.require(lease.context.shared.id)); }
      catch { this.leases.delete(key); }
      if (lease.expiresAt <= Date.now()) this.leases.delete(key);
    }
    for (const [key, watch] of this.#watches) {
      try { this.#service.scope(watch.scope, watch.connection); }
      catch { this.#deliver(watch); this.#remove(key); continue; }
      this.#background(this.#renew(watch, true));
    }
    this.#disarm();
  }
  close(): void {
    this.#closed = true;
    if (this.#coalescer) clearTimeout(this.#coalescer);
    if (this.timer) clearInterval(this.timer);
    this.#coalescer = null; this.timer = null;
    for (const key of this.#watches.keys()) this.#remove(key);
    this.leases.clear(); this.#cancelled.clear(); this.#dirty.clear();
  }
  async settled(): Promise<void> { await Promise.allSettled(this.#pending); }
}
