/** Shared data belongs to one Store/client, never to a foreign thread with the same ID. */
import type { AgentTranscript, RpcMethodName, RpcParams, RpcResult, SharedAccessPage, SharedBoardCard, SharedBoardPage, SharedComputeJob, SharedProjectScope, SharedProjectThread, SharedProjectView } from '@boite/contracts';
import type { Client } from '../client';
import { secureId } from '../secure-id';
import type { StoreContext } from './context';

export type SharedMethod = Extract<RpcMethodName, `sharedProjects.${string}` | `sharedBoard.${string}` | `sharedCompute.${string}` | `sharedAccess.${string}` | 'contacts.sendHuman'>;
export type SharedSurface = 'threads' | 'board' | 'compute' | 'access';
export interface SharedScopeView {
  scope: SharedProjectScope;
  project: SharedProjectView | null;
  threads: SharedProjectThread[];
  unavailable: SharedProjectThread['ref']['project'][];
  board: SharedBoardCard[];
  boardRevision: number | null;
  authorityAvailable: boolean;
  jobs: SharedComputeJob[];
  access: SharedAccessPage | null;
  loading: boolean;
  error: string | null;
}
interface Watch {
  value: SharedScopeView;
  consumers: Map<symbol, ReadonlySet<SharedSurface>>;
  client: Client | null;
  subscribed: boolean;
  epoch: number;
  reading: Promise<void> | null;
  trailing: boolean;
  accessAfter?: string;
}
const scopeKey = (p: SharedProjectScope) => JSON.stringify([p.threadId, p.sharedProjectId]);

export class SharedProjects {
  projects = $state<Record<string, SharedProjectView[]>>({});
  scopes = $state<Record<string, SharedScopeView>>({});
  readonly #watches = new Map<string, Watch>();
  readonly #lists = new Map<string, number>();
  #epoch = 0;

  constructor(private readonly ctx: StoreContext) {}

  /** Canonical identity and relay address remain separate and are never parsed from each other. */
  threadKey(ref: SharedProjectThread['ref']): string {
    return JSON.stringify([ref.project.ownerCoreId, ref.project.coreId, ref.project.projectId, ref.threadId]);
  }
  view(scope: SharedProjectScope): SharedScopeView | undefined { return this.scopes[scopeKey(scope)]; }

  async load(threadId: string): Promise<SharedProjectView[]> {
    const client = this.#client(), epoch = this.#epoch, read = (this.#lists.get(threadId) ?? 0) + 1;
    this.#lists.set(threadId, read);
    const rows = await client.call('sharedProjects.list', {threadId});
    if (client === this.ctx.client && epoch === this.#epoch && this.#lists.get(threadId) === read) this.projects[threadId] = rows;
    return rows;
  }

  /** Each drawn surface owns a lease. No subscription, timer or read exists before watch(). */
  watch(scope: SharedProjectScope, surfaces: readonly SharedSurface[] = ['threads', 'board', 'compute', 'access']): () => void {
    const key = scopeKey(scope), token = Symbol();
    let watch = this.#watches.get(key);
    if (!watch) {
      this.scopes[key] = {scope: {...scope}, project: null, threads: [], unavailable: [], board: [], boardRevision: null, authorityAvailable: false, jobs: [], access: null, loading: false, error: null};
      watch = {value: this.scopes[key]!, consumers: new Map(), client: null, subscribed: false, epoch: 0, reading: null, trailing: false};
      this.#watches.set(key, watch);
    }
    watch.consumers.set(token, new Set(surfaces));
    void this.refresh(scope);
    return () => {
      if (this.#watches.get(key) !== watch) return;
      watch.consumers.delete(token);
      if (watch.consumers.size) return;
      this.#release(watch);
      this.#clear(watch);
      this.#watches.delete(key);
      delete this.scopes[key];
    };
  }

  changed(scope: {sharedProjectId: string; threadId?: string}): void {
    for (const watch of this.#watches.values()) {
      const target = watch.value.scope;
      if (target.sharedProjectId === scope.sharedProjectId && (scope.threadId === undefined || target.threadId === scope.threadId)) void this.refresh(target);
    }
  }
  /** Reconnects keep only consumer intent; every old result and server lease is invalid. */
  disconnected(): void {
    this.#epoch++;
    this.projects = {};
    this.#lists.clear();
    for (const watch of this.#watches.values()) { this.#release(watch, false); this.#clear(watch); }
  }
  reconnected(): void { for (const watch of this.#watches.values()) void this.refresh(watch.value.scope); }
  reset(): void {
    for (const watch of this.#watches.values()) this.#release(watch);
    this.disconnected();
    this.#watches.clear();
    this.scopes = {};
  }
  #clear(watch: Watch): void {
    Object.assign(watch.value, {project: null, threads: [], unavailable: [], board: [], boardRevision: null, authorityAvailable: false, jobs: [], access: null, loading: false, error: null});
  }
  #release(watch: Watch, send = true): void {
    const client = watch.client;
    watch.epoch++;
    watch.client = null;
    watch.subscribed = false;
    watch.reading = null;
    watch.trailing = false;
    if (send && client?.state === 'ready') void client.call('sharedProjects.subscribe', {...watch.value.scope, enabled: false}).catch(() => undefined);
  }
  #client(): Client {
    const client = this.ctx.client;
    if (!client || client.state !== 'ready') throw new Error('This machine is disconnected.');
    return client;
  }
  refresh(scope: SharedProjectScope): Promise<void> {
    const watch = this.#watches.get(scopeKey(scope));
    if (!watch || this.ctx.client?.state !== 'ready') return Promise.resolve();
    if (watch.reading) { watch.trailing = true; return watch.reading; }
    const client = this.ctx.client, epoch = watch.epoch;
    const current = () => watch.epoch === epoch && this.ctx.client === client && this.#watches.get(scopeKey(scope)) === watch;
    watch.value.loading = true;
    const read = this.#read(watch, client, current).catch(error => {
      if (!current()) return;
      this.#clear(watch);
      watch.value.error = this.ctx.reason(error);
      this.#release(watch);
    }).finally(() => {
      if (!current()) return;
      watch.reading = null;
      watch.value.loading = false;
      if (watch.trailing) { watch.trailing = false; void this.refresh(scope); }
    });
    watch.reading = read;
    return read;
  }
  async #read(watch: Watch, client: Client, current: () => boolean): Promise<void> {
    const p = watch.value.scope;
    const project = await client.call('sharedProjects.get', p);
    if (!current()) return;
    watch.value.project = project;
    const listed = this.projects[p.threadId];
    if (listed) this.projects[p.threadId] = listed.map(row => row.shared.id === project.shared.id ? project : row);
    if (project.shared.state !== 'active') {
      this.#clear(watch);
      watch.value.project = project;
      this.#release(watch);
      return;
    }
    if (!watch.subscribed) {
      watch.client = client;
      await client.call('sharedProjects.subscribe', {...p, enabled: true});
      if (!current()) return;
      watch.subscribed = true;
    }
    const surfaces = new Set([...watch.consumers.values()].flatMap(s => [...s]));
    const apply = async <T>(promise: Promise<T>, put: (value: T) => void) => { const result = await promise; if (current()) put(result); };
    await Promise.all([
      ...(surfaces.has('threads') ? [apply(client.call('sharedProjects.threads', p), r => {watch.value.threads = r.threads; watch.value.unavailable = r.unavailable;})] : []),
      ...(surfaces.has('board') && project.shared.access.every(a => a.board) ? [this.#board(watch, client, current)] : []),
      ...(surfaces.has('compute') ? [apply(client.call('sharedCompute.list', p), jobs => {watch.value.jobs = jobs;})] : []),
      // Re-read the displayed page: a delayed verdict can change it without adding a new event.
      ...(surfaces.has('access') ? [apply(client.call('sharedAccess.get', {...p, ...(watch.accessAfter ? {after: watch.accessAfter} : {})}), page => {watch.value.access = page;})] : [])
    ]);
    if (!project.shared.access.every(a => a.board) && current()) { watch.value.board = []; watch.value.boardRevision = null; watch.value.authorityAvailable = false; }
  }
  async #board(watch: Watch, client: Client, current: () => boolean): Promise<void> {
    let more: boolean;
    do {
      const page = await client.call('sharedBoard.get', {...watch.value.scope, ...(watch.value.boardRevision === null ? {} : {after: watch.value.boardRevision})});
      if (!current()) return;
      more = this.#applyBoard(watch.value, page);
    } while (more);
  }
  #applyBoard(view: SharedScopeView, page: SharedBoardPage): boolean {
    view.authorityAvailable = page.authorityAvailable !== false;
    if (page.kind === 'snapshot') { view.board = page.cards; view.boardRevision = page.revision; return false; }
    if (view.boardRevision !== page.from) { view.boardRevision = null; return true; }
    const cards = new Map(view.board.map(card => [card.id, card]));
    for (const change of page.changes) {
      if (change.kind === 'deleted') cards.delete(change.tombstone.id);
      else cards.set(change.card.id, change.card);
    }
    view.board = [...cards.values()];
    view.boardRevision = page.to;
    return page.more;
  }
  async accessPage(scope: SharedProjectScope, after?: string): Promise<void> {
    const watch = this.#watches.get(scopeKey(scope));
    if (!watch) return;
    watch.accessAfter = after;
    await this.refresh(scope);
  }
  /** All RPCs use this Store's client. Foreign canonical refs are passed intact, never opened as local threads. */
  async call<M extends SharedMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const client = this.#client(), epoch = this.#epoch;
    const result = await client.call(method, params);
    if (client !== this.ctx.client || epoch !== this.#epoch) throw new Error('This machine connection changed.');
    if ('sharedProjectId' in params) this.changed(params as {sharedProjectId: string; threadId?: string});
    return result;
  }
  read(params: RpcParams<'sharedProjects.read'>): Promise<AgentTranscript> { return this.call('sharedProjects.read', params); }
  sendHuman(params: Omit<RpcParams<'contacts.sendHuman'>, 'requestId'> & {requestId?: string}) {
    return this.call('contacts.sendHuman', {...params, requestId: params.requestId ?? secureId()});
  }
}
