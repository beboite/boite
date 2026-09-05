import type {
  Account,
  CoreInfo,
  Message,
  PermissionMode,
  PermissionRequest,
  ProcessRecord,
  Project,
  ProjectId,
  ProviderId,
  ProviderRejected,
  ProviderSummary,
  RequestId,
  RpcEventName,
  SchedulerState,
  Settings,
  Thread,
  ThreadId,
  ThreadResources,
  ThreadSummary,
  Usage
} from '@boite/contracts';
import {
  RpcFailure,
  WsClient,
  type Client,
  type ClientState,
  type EventHandler,
  type ObservableClient
} from './client';
import { resolveEndpoint, storeEndpoint } from './endpoint';

export type Page = 'threads' | 'resources' | 'accounts' | 'usage' | 'settings';
export type ThreadTab = 'chat' | 'trace';

export interface UsageReport {
  byThread: Record<ThreadId, Usage>;
  total: Usage;
}

export const UI_VERSION = '2.0.0-alpha.1';

function observable(client: Client): client is ObservableClient {
  return 'onState' in client;
}

/** A pid alone is reused by the OS, so a trace row is a pid and its start. */
function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

export class Store {
  connection = $state<ClientState>('idle');
  core = $state<CoreInfo | null>(null);
  error = $state<string | null>(null);
  page = $state<Page>('threads');
  tab = $state<ThreadTab>('chat');
  booted = $state(false);

  projects = $state<Project[]>([]);
  threads = $state<ThreadSummary[]>([]);
  openThread = $state<Thread | null>(null);
  providers = $state<ProviderSummary[]>([]);
  rejectedProviders = $state<ProviderRejected[]>([]);
  accounts = $state<Account[]>([]);
  scheduler = $state<SchedulerState | null>(null);
  settings = $state<Settings | null>(null);
  resources = $state<ThreadResources[]>([]);
  usage = $state<UsageReport | null>(null);
  trace = $state<ProcessRecord[]>([]);
  pendingPermissions = $state<PermissionRequest[]>([]);
  /** Kept after the answer so a resolved card still shows what was asked. */
  permissionRequests = $state<Record<RequestId, PermissionRequest>>({});
  collapsedProjects = $state<string[]>([]);

  #client: Client | null = null;
  #off: (() => void)[] = [];
  #subscribedThreadId: ThreadId | null = null;

  get client(): Client | null {
    return this.#client;
  }

  get unreadCount(): number {
    return this.threads.filter((t) => t.unread).length;
  }

  threadsOf(projectId: ProjectId): ThreadSummary[] {
    return this.threads.filter((t) => t.projectId === projectId && !t.archived);
  }

  accountsOf(providerId: ProviderId): Account[] {
    return this.accounts.filter((a) => a.providerId === providerId);
  }

  providerOf(id: ProviderId): ProviderSummary | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }

  accountOf(id: string): Account | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  isCollapsed(projectId: ProjectId): boolean {
    return this.collapsedProjects.includes(projectId);
  }

  toggleProject(projectId: ProjectId): void {
    this.collapsedProjects = this.isCollapsed(projectId)
      ? this.collapsedProjects.filter((id) => id !== projectId)
      : [...this.collapsedProjects, projectId];
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  attach(client: Client): void {
    this.detach();
    this.#client = client;
    this.connection = client.state;

    const on = <E extends RpcEventName>(event: E, handler: EventHandler<E>): void => {
      this.#off.push(client.on(event, handler));
    };

    if (observable(client)) {
      this.#off.push(
        client.onState((state) => {
          this.connection = state;
          if (state === 'ready') {
            this.error = null;
            this.core = client.core;
            void this.reload();
          }
        })
      );
    }

    on('thread.created', (summary) => {
      if (!this.threads.some((t) => t.id === summary.id)) this.threads = [...this.threads, summary];
    });
    on('thread.updated', (summary) => {
      this.threads = this.threads.map((t) => (t.id === summary.id ? summary : t));
      if (!this.threads.some((t) => t.id === summary.id)) this.threads = [...this.threads, summary];
      const open = this.openThread;
      if (open && open.id === summary.id) Object.assign(open, summary);
    });
    on('thread.removed', ({ threadId }) => {
      this.threads = this.threads.filter((t) => t.id !== threadId);
      if (this.openThread?.id === threadId) this.openThread = null;
    });

    on('turn.started', (turn) => this.#upsertTurn(turn.threadId, turn));
    on('turn.finished', (turn) => {
      this.#upsertTurn(turn.threadId, turn);
      void this.refreshUsage();
    });

    on('message.started', (message) => {
      const open = this.openThread;
      if (!open || open.id !== message.threadId) return;
      const index = open.messages.findIndex((m) => m.id === message.id);
      if (index >= 0) open.messages[index] = message;
      else open.messages.push(message);
    });

    on('message.delta', ({ threadId, messageId, partIndex, text }) => {
      const message = this.#message(threadId, messageId);
      if (!message) return;
      const part = message.parts[partIndex];
      if (part && part.type === 'text') part.text += text;
      else if (!part) message.parts[partIndex] = { type: 'text', text };
    });

    on('message.part', ({ threadId, messageId, partIndex, part }) => {
      const message = this.#message(threadId, messageId);
      if (!message) return;
      message.parts[partIndex] = part;
    });

    on('message.completed', ({ threadId, messageId, state }) => {
      const message = this.#message(threadId, messageId);
      if (message) message.state = state;
    });

    on('permission.requested', (request) => {
      this.pendingPermissions = [
        ...this.pendingPermissions.filter((p) => p.id !== request.id),
        request
      ];
      this.permissionRequests = { ...this.permissionRequests, [request.id]: request };
    });
    on('permission.resolved', ({ requestId }) => {
      this.pendingPermissions = this.pendingPermissions.filter((p) => p.id !== requestId);
    });

    on('process.started', (record) => {
      if (this.openThread?.id !== record.threadId) return;
      this.trace = [record, ...this.trace.filter((p) => !sameProcess(p, record))];
    });
    on('process.exited', (record) => {
      if (this.openThread?.id !== record.threadId) return;
      this.trace = this.trace.map((p) => (sameProcess(p, record) ? record : p));
    });

    on('scheduler.updated', (state) => {
      this.scheduler = state;
    });
    on('accounts.updated', (account) => {
      this.accounts = this.accounts.some((a) => a.id === account.id)
        ? this.accounts.map((a) => (a.id === account.id ? account : a))
        : [...this.accounts, account];
    });
    on('core.log', (entry) => {
      if (entry.level === 'error') this.error = entry.message;
    });
  }

  detach(): void {
    for (const off of this.#off) off();
    this.#off = [];
    this.#client = null;
    this.#subscribedThreadId = null;
  }

  /** Picks the transport, connects, loads everything the UI opens on. */
  async boot(): Promise<void> {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('fake') === '1') {
        const { FakeClient } = await import('./fake-client');
        this.attach(new FakeClient());
      } else {
        const endpoint = await resolveEndpoint();
        if (!endpoint) {
          this.connection = 'closed';
          this.booted = true;
          return;
        }
        this.attach(
          new WsClient({
            url: endpoint.url,
            token: endpoint.token,
            clientName: window.__TAURI_INTERNALS__ === undefined ? 'pwa' : 'shell',
            version: UI_VERSION
          })
        );
      }
      await this.connect();
      const first = this.threads[0];
      if (!this.openThread && first) await this.open(first.id);
    } finally {
      this.booted = true;
    }
  }

  async connect(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.core = await client.connect();
      this.connection = client.state;
      this.error = null;
      await this.reload();
    } catch (error) {
      this.connection = client.state;
      this.#fail(error);
    }
  }

  /** Point the UI at another core, from the Settings page. */
  async connectTo(url: string, token: string): Promise<void> {
    this.#client?.close();
    this.detach();
    storeEndpoint({ url, token });
    this.openThread = null;
    this.attach(new WsClient({ url, token, clientName: 'pwa', version: UI_VERSION }));
    await this.connect();
  }

  async reload(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const [projects, threads, providers, accounts, settings, scheduler] = await Promise.all([
        client.call('projects.list', {}),
        client.call('threads.list', {}),
        client.call('providers.list', {}),
        client.call('accounts.list', {}),
        client.call('settings.get', {}),
        client.call('scheduler.get', {})
      ]);
      this.projects = projects;
      this.threads = threads;
      this.providers = providers.loaded;
      this.rejectedProviders = providers.rejected;
      this.accounts = accounts;
      this.settings = settings;
      this.scheduler = scheduler;
      const open = this.openThread;
      if (open) await this.open(open.id);
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async open(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const previous = this.#subscribedThreadId;
      if (previous && previous !== threadId) {
        this.#subscribedThreadId = null;
        await client.call('threads.unsubscribe', { threadId: previous });
      }
      await client.call('threads.subscribe', { threadId });
      this.#subscribedThreadId = threadId;
      const thread = await client.call('threads.get', { threadId });
      this.openThread = thread;
      this.trace = await client.call('trace.get', { threadId });
      if (thread.unread) {
        await client.call('threads.markRead', { threadId });
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  async addProject(path: string): Promise<Project | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      const project = await client.call('projects.add', { path });
      if (!this.projects.some((p) => p.id === project.id))
        this.projects = [...this.projects, project];
      return project;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async createThread(input: {
    projectId: ProjectId;
    providerId: ProviderId;
    accountId: string;
    title?: string;
    permissionMode?: PermissionMode;
  }): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const summary = await client.call('threads.create', input);
      if (!this.threads.some((t) => t.id === summary.id)) this.threads = [...this.threads, summary];
      await this.open(summary.id);
    } catch (error) {
      this.#fail(error);
    }
  }

  async send(prompt: string): Promise<void> {
    const client = this.#client;
    const open = this.openThread;
    if (!client || !open || prompt.trim().length === 0) return;
    try {
      await client.call('turns.start', { threadId: open.id, prompt });
    } catch (error) {
      this.#fail(error);
    }
  }

  async stop(): Promise<void> {
    const client = this.#client;
    const open = this.openThread;
    if (!client || !open) return;
    try {
      await client.call('turns.stop', { threadId: open.id });
    } catch (error) {
      this.#fail(error);
    }
  }

  async answer(requestId: string, decision: 'allow' | 'deny'): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('permissions.answer', { requestId, decision });
      this.pendingPermissions = this.pendingPermissions.filter((p) => p.id !== requestId);
    } catch (error) {
      this.#fail(error);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const client = this.#client;
    const open = this.openThread;
    if (!client || !open) return;
    try {
      const summary = await client.call('threads.update', {
        threadId: open.id,
        permissionMode: mode
      });
      Object.assign(open, summary);
      this.threads = this.threads.map((t) => (t.id === summary.id ? summary : t));
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  async refreshTrace(): Promise<void> {
    const client = this.#client;
    const open = this.openThread;
    if (!client || !open) return;
    try {
      this.trace = await client.call('trace.get', { threadId: open.id });
    } catch (error) {
      this.#fail(error);
    }
  }

  async refreshResources(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.resources = await client.call('resources.list', {});
    } catch (error) {
      this.#fail(error);
    }
  }

  async refreshUsage(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.usage = await client.call('usage.get', {});
    } catch (error) {
      this.#fail(error);
    }
  }

  async killTree(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('resources.killTree', { threadId });
      await this.refreshResources();
    } catch (error) {
      this.#fail(error);
    }
  }

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.settings = await client.call('settings.set', patch);
    } catch (error) {
      this.#fail(error);
    }
  }

  async addAccount(input: {
    providerId: ProviderId;
    label: string;
    useDefaultLocation?: boolean;
  }): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const account = await client.call('accounts.add', input);
      if (!this.accounts.some((a) => a.id === account.id))
        this.accounts = [...this.accounts, account];
    } catch (error) {
      this.#fail(error);
    }
  }

  async checkAccount(accountId: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const account = await client.call('accounts.check', { accountId });
      this.accounts = this.accounts.map((a) => (a.id === account.id ? account : a));
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #message(threadId: ThreadId, messageId: string): Message | null {
    const open = this.openThread;
    if (!open || open.id !== threadId) return null;
    return open.messages.find((m) => m.id === messageId) ?? null;
  }

  #upsertTurn(threadId: ThreadId, turn: Thread['turns'][number]): void {
    const open = this.openThread;
    if (!open || open.id !== threadId) return;
    const index = open.turns.findIndex((t) => t.id === turn.id);
    if (index >= 0) open.turns[index] = turn;
    else open.turns.push(turn);
  }

  #fail(error: unknown): void {
    if (error instanceof RpcFailure) this.error = `${error.message} (${error.code})`;
    else if (error instanceof Error) this.error = error.message;
    else this.error = String(error);
  }
}

export const store = new Store();
