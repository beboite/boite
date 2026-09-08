import type {
  Account,
  CoreInfo,
  Message,
  ModelInfo,
  PermissionMode,
  PermissionRequest,
  ProcessRecord,
  Project,
  ProjectId,
  ProviderId,
  ProviderInstallState,
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
import { titleFrom } from './format';
import {
  clampSidebar,
  defaultPrefs,
  readLayout,
  readPrefs,
  SIDEBAR_DEFAULT,
  writeLayout,
  writePrefs,
  type ComposerPrefs
} from './prefs';
import { rightPanel, type BoundPanel } from './right-panel.svelte';
import { strings } from './strings';

export type Page = 'chat' | 'settings';
export type SettingsTab = 'general' | 'accounts' | 'usage' | 'resources';

/** A login process the core runs for one account, as `account.login` reports it. */
export interface LoginState {
  state: 'running' | 'failed';
  /** The last line the provider CLI printed. */
  output: string;
  /** The first https link it printed, once there is one. */
  url: string | null;
  exitCode: number | null;
}

export interface UsageReport {
  byThread: Record<ThreadId, Usage>;
  total: Usage;
}

/** A thread that exists only in the UI until its first message is sent. */
export interface Draft {
  projectId: ProjectId;
}

/** What the composer sends a message with. */
export interface Choice {
  providerId: ProviderId;
  accountId: string;
  permissionMode: PermissionMode;
  model: string | null;
  /** A level id of that model, or null for the model's own default. */
  effort: string | null;
}

/** What the picker hands back: the instance and model together, or an effort alone. */
export interface PickPatch {
  providerId?: ProviderId;
  accountId?: string;
  model?: string | null;
  effort?: string | null;
}

export const UI_VERSION = '2.0.0-alpha.1';

function observable(client: Client): client is ObservableClient {
  return 'onState' in client;
}

/** What the summaries say about every managed install, as one map. */
function installStatesOf(providers: ProviderSummary[]): Record<ProviderId, ProviderInstallState> {
  const out: Record<ProviderId, ProviderInstallState> = {};
  for (const provider of providers) {
    if (provider.install !== null) out[provider.id] = provider.install;
  }
  return out;
}

/** One probe answer per provider and account, the key the core uses too. */
export function probeKey(providerId: ProviderId, accountId: string): string {
  return `${providerId}::${accountId}`;
}

/** A pid alone is reused by the OS, so a trace row is a pid and its start. */
function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

const LIVE: ThreadStatusRank = { waiting: 0, running: 1, queued: 2, error: 3, idle: 4 };
type ThreadStatusRank = Record<ThreadSummary['status'], number>;

export class Store {
  connection = $state<ClientState>('idle');
  core = $state<CoreInfo | null>(null);
  error = $state<string | null>(null);
  page = $state<Page>('chat');
  settingsTab = $state<SettingsTab>('general');
  /** The phone drawer. */
  sidebarOpen = $state(false);
  /** The desktop sidebar, folded with Ctrl+B. */
  sidebarCollapsed = $state(false);
  sidebarWidth = $state(SIDEBAR_DEFAULT);
  /** A folder is being dragged over the window. */
  dropping = $state(false);
  search = $state('');
  booted = $state(false);

  projects = $state<Project[]>([]);
  threads = $state<ThreadSummary[]>([]);
  openThread = $state<Thread | null>(null);
  draft = $state<Draft | null>(null);
  prefs = $state<ComposerPrefs>(defaultPrefs());
  providers = $state<ProviderSummary[]>([]);
  rejectedProviders = $state<ProviderRejected[]>([]);
  /**
   * Where each managed install stands, keyed by provider. The summaries seed it
   * and `providers.installProgress` moves it while a download runs, which is the
   * only state a summary cannot carry between two `providers.list` calls.
   */
  installStates = $state<Record<ProviderId, ProviderInstallState>>({});
  /**
   * What an agent answered `providers.probe` with, keyed `providerId::accountId`.
   * An ACP agent owns its model list; the descriptor only carries `default`.
   */
  probedModels = $state<Record<string, ModelInfo[]>>({});
  /** The keys a probe is running for, so the picker can say it is reading. */
  probingModels = $state<string[]>([]);
  accounts = $state<Account[]>([]);
  /** Keyed by account id: one entry while a login runs, and after one failed. */
  logins = $state<Record<string, LoginState>>({});
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

  /** The project of the open thread or of the draft, the one the composer writes into. */
  get openProject(): Project | null {
    const id = this.openThread?.projectId ?? this.draft?.projectId ?? null;
    return id === null ? null : (this.projects.find((p) => p.id === id) ?? null);
  }

  get busy(): boolean {
    const status = this.openThread?.status;
    return status === 'running' || status === 'queued' || status === 'waiting';
  }

  threadsOf(projectId: ProjectId): ThreadSummary[] {
    return this.threads.filter((t) => t.projectId === projectId && !t.archived);
  }

  /** Live threads first, then by last activity; the search box narrows it. */
  sortedThreadsOf(projectId: ProjectId): ThreadSummary[] {
    const needle = this.search.trim().toLowerCase();
    return this.threadsOf(projectId)
      .filter((t) => needle === '' || t.title.toLowerCase().includes(needle))
      .sort((a, b) => LIVE[a.status] - LIVE[b.status] || b.updatedAt - a.updatedAt);
  }

  accountsOf(providerId: ProviderId): Account[] {
    return this.accounts.filter((a) => a.providerId === providerId);
  }

  providerOf(id: ProviderId): ProviderSummary | null {
    return this.providers.find((p) => p.id === id) ?? null;
  }

  /** Null when this provider ships no release for Boite to install. */
  installOf(id: ProviderId): ProviderInstallState | null {
    return this.installStates[id] ?? this.providerOf(id)?.install ?? null;
  }

  accountOf(id: string): Account | null {
    return this.accounts.find((a) => a.id === id) ?? null;
  }

  /**
   * The models to offer for this instance: the ones the agent listed when a
   * probe already ran, else the descriptor's.
   */
  modelsOf(providerId: ProviderId, accountId: string | null): ModelInfo[] {
    const probed = accountId ? this.probedModels[probeKey(providerId, accountId)] : undefined;
    return probed ?? this.providerOf(providerId)?.models ?? [];
  }

  isProbing(providerId: ProviderId, accountId: string | null): boolean {
    return accountId !== null && this.probingModels.includes(probeKey(providerId, accountId));
  }

  /**
   * Ask the agent what it can run. Once per instance per session: the answer
   * stays until the core reloads its descriptors or the account changes.
   */
  async probeModels(providerId: ProviderId, accountId: string): Promise<void> {
    const client = this.#client;
    const key = probeKey(providerId, accountId);
    if (!client || this.probedModels[key] || this.probingModels.includes(key)) return;
    this.probingModels = [...this.probingModels, key];
    try {
      const { models } = await client.call('providers.probe', { providerId, accountId });
      this.probedModels = { ...this.probedModels, [key]: models };
    } catch (error) {
      this.#fail(error);
    } finally {
      this.probingModels = this.probingModels.filter((entry) => entry !== key);
    }
  }

  isCollapsed(projectId: ProjectId): boolean {
    return this.collapsedProjects.includes(projectId);
  }

  toggleProject(projectId: ProjectId): void {
    this.collapsedProjects = this.isCollapsed(projectId)
      ? this.collapsedProjects.filter((id) => id !== projectId)
      : [...this.collapsedProjects, projectId];
  }

  /** The model a fresh thread on this provider gets: the flagged default, else the first current one. */
  defaultModelOf(provider: ProviderSummary): string | null {
    const flagged = provider.models.find((m) => m.default);
    const current = provider.models.find((m) => !m.legacy);
    return flagged?.id ?? current?.id ?? provider.models[0]?.id ?? null;
  }

  /**
   * What the composer opens on: the remembered provider and account when they
   * still exist, else the first available provider and its first account.
   */
  defaultChoice(): Choice | null {
    const remembered = this.prefs.providerId ? this.providerOf(this.prefs.providerId) : null;
    const provider =
      (remembered?.available ? remembered : null) ??
      this.providers.find((p) => p.available && this.accountsOf(p.id).length > 0) ??
      this.providers.find((p) => this.accountsOf(p.id).length > 0) ??
      null;
    if (!provider) return null;
    const accounts = this.accountsOf(provider.id);
    const account =
      accounts.find((a) => a.id === this.prefs.accountId) ??
      accounts.find((a) => a.status === 'ok') ??
      accounts[0];
    if (!account) return null;
    // A probed model is as remembered as a descriptor one: the agent listed it.
    const offered = this.modelsOf(provider.id, account.id);
    const model =
      this.prefs.model && offered.some((m) => m.id === this.prefs.model)
        ? this.prefs.model
        : this.defaultModelOf(provider);
    const levels = offered.find((m) => m.id === model)?.effort?.levels ?? [];
    const effort = levels.some((level) => level.id === this.prefs.effort) ? this.prefs.effort : null;
    return {
      providerId: provider.id,
      accountId: account.id,
      permissionMode: this.prefs.permissionMode,
      model,
      effort
    };
  }

  remember(choice: Choice): void {
    this.prefs = { ...choice };
    writePrefs(this.prefs);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  setSidebarWidth(width: number): void {
    this.sidebarWidth = clampSidebar(width);
    writeLayout({ sidebarWidth: this.sidebarWidth, sidebarCollapsed: this.sidebarCollapsed });
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    writeLayout({ sidebarWidth: this.sidebarWidth, sidebarCollapsed: this.sidebarCollapsed });
  }

  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      this.error = strings.errors.clipboard;
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  attach(client: Client): void {
    this.detach();
    this.#client = client;
    this.connection = client.state;
    this.prefs = readPrefs();
    const layout = readLayout();
    this.sidebarWidth = layout.sidebarWidth;
    this.sidebarCollapsed = layout.sidebarCollapsed;

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

    // Rows are patched in place: a load tick on one running thread must not
    // hand the sidebar a new array and re-render every other row.
    on('thread.created', (summary) => this.#upsertThread(summary));
    on('thread.updated', (summary) => {
      this.#upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === summary.id) Object.assign(open, summary);
    });
    on('thread.removed', ({ threadId }) => {
      this.threads = this.threads.filter((t) => t.id !== threadId);
      if (this.openThread?.id === threadId) this.openThread = null;
      // A thread that left Boite takes its panel layout with it.
      rightPanel.forget(threadId);
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
      // A delta appends to whatever kind of text part sits there: text or thinking.
      if (part && (part.type === 'text' || part.type === 'thinking')) part.text += text;
      // On a tool part it is the input's JSON, still being typed by the model.
      else if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + text;
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
      this.#mergePermissions([request]);
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
    on('account.login', (event) => {
      if (event.state === 'done') {
        const { [event.accountId]: _done, ...rest } = this.logins;
        this.logins = rest;
        return;
      }
      this.logins = {
        ...this.logins,
        [event.accountId]: {
          state: event.state,
          output: event.output,
          url: event.url,
          exitCode: event.exitCode
        }
      };
    });
    on('accounts.updated', (account) => {
      this.accounts = this.accounts.some((a) => a.id === account.id)
        ? this.accounts.map((a) => (a.id === account.id ? account : a))
        : [...this.accounts, account];
      // The core forgets its probe for a changed account; so does the UI, or
      // the picker offers a model the core no longer accepts.
      this.#dropProbes(account.id);
    });
    // The five below also reach the client that made the call, so every handler
    // has to survive being applied twice.
    on('accounts.removed', ({ accountId }) => {
      this.accounts = this.accounts.filter((a) => a.id !== accountId);
      const { [accountId]: _gone, ...rest } = this.logins;
      this.logins = rest;
      this.#dropProbes(accountId);
    });
    on('settings.updated', (settings) => {
      this.settings = settings;
    });
    on('providers.installProgress', ({ providerId, ...state }) => {
      this.installStates = { ...this.installStates, [providerId]: state as ProviderInstallState };
    });
    on('providers.updated', ({ loaded, rejected }) => {
      this.providers = loaded;
      this.rejectedProviders = rejected;
      // A summary that just landed is newer than any progress this client kept.
      this.installStates = installStatesOf(loaded);
      // The core drops its own probes on a reload; holding stale ones would
      // offer a model it now refuses.
      this.probedModels = {};
    });
    on('providers.probed', ({ providerId, accountId, models }) => {
      this.probedModels = { ...this.probedModels, [probeKey(providerId, accountId)]: models };
    });
    on('project.added', (project) => {
      if (!this.projects.some((p) => p.id === project.id))
        this.projects = [...this.projects, project];
    });
    on('project.removed', ({ projectId }) => {
      void this.#dropProject(projectId);
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
        // `&long=1` adds the four-hundred-message thread the windowed list is looked at on.
        this.attach(new FakeClient({ long: params.get('long') === '1' }));
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
      await this.openWhereLeft();
    } finally {
      this.booted = true;
    }
  }

  /** The most recent thread, a draft in the first project, or nothing on a first run. */
  async openWhereLeft(): Promise<void> {
    if (this.openThread || this.draft) return;
    const live = this.threads.filter((t) => !t.archived);
    const recent = [...live].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (recent) {
      await this.open(recent.id);
      return;
    }
    const project = this.projects[0];
    if (project) this.startDraft(project.id);
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
    this.draft = null;
    this.attach(new WsClient({ url, token, clientName: 'pwa', version: UI_VERSION }));
    await this.connect();
    await this.openWhereLeft();
  }

  async reload(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const [projects, threads, providers, accounts, settings, scheduler, permissions] = await Promise.all([
        client.call('projects.list', {}),
        client.call('threads.list', {}),
        client.call('providers.list', {}),
        client.call('accounts.list', {}),
        client.call('settings.get', {}),
        client.call('scheduler.get', {}),
        client.call('permissions.list', {})
      ]);
      this.#mergePermissions(permissions);
      this.projects = projects;
      this.threads = threads;
      this.providers = providers.loaded;
      this.rejectedProviders = providers.rejected;
      this.installStates = installStatesOf(providers.loaded);
      this.accounts = accounts;
      this.logins = {};
      this.settings = settings;
      this.scheduler = scheduler;
      const open = this.openThread;
      if (open) await this.open(open.id);
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  showSettings(tab: SettingsTab = 'general'): void {
    this.settingsTab = tab;
    this.page = 'settings';
    if (tab === 'usage') void this.refreshUsage();
    if (tab === 'resources') void this.refreshResources();
  }

  showChat(): void {
    this.page = 'chat';
  }

  /** The right panel of the thread that is open, surfaces and all. */
  get panel(): BoundPanel {
    return rightPanel.for(this.openThread?.id ?? null);
  }

  /** Whether that panel is showing. The chat header's button reads it. */
  get panelOpen(): boolean {
    return this.panel.isOpen;
  }

  /** The header's Trace button: the panel opens on trace, or shuts on it. */
  togglePanel(): void {
    this.panel.toggleTrace();
    if (this.panelOpen) void this.refreshTrace();
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  /** The native folder picker in the shell; a browser has no such thing and types a path. */
  async pickProject(): Promise<Project | null> {
    if (window.__TAURI_INTERNALS__ === undefined) return null;
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== 'string' || picked.length === 0) return null;
      return await this.addProject(picked);
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async addProject(path: string): Promise<Project | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      const project = await client.call('projects.add', { path });
      if (!this.projects.some((p) => p.id === project.id))
        this.projects = [...this.projects, project];
      this.startDraft(project.id);
      return project;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  /** Folders dropped on the window. The core refuses a file, and the toast says so. */
  async addProjects(paths: string[]): Promise<void> {
    let first: Project | null = null;
    for (const path of paths) {
      const project = await this.addProject(path);
      first ??= project;
    }
    if (first) this.startDraft(first.id);
  }

  async removeProject(projectId: ProjectId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('projects.remove', { projectId });
      await this.#dropProject(projectId);
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  /** An empty chat in a project, composer focused. Nothing reaches the core until the first send. */
  startDraft(projectId?: ProjectId): void {
    const target = projectId ?? this.openProject?.id ?? this.projects[0]?.id;
    if (target === undefined) return;
    void this.#unsubscribe();
    this.openThread = null;
    this.trace = [];
    this.draft = { projectId: target };
    this.page = 'chat';
    this.sidebarOpen = false;
  }

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
      this.draft = null;
      this.openThread = thread;
      this.page = 'chat';
      this.sidebarOpen = false;
      this.trace = await client.call('trace.get', { threadId });
      // The thread may already be waiting on a request this page never saw.
      this.#mergePermissions(await client.call('permissions.list', { threadId }));
      if (thread.unread) {
        await client.call('threads.markRead', { threadId });
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  async createThread(input: {
    projectId: ProjectId;
    providerId: ProviderId;
    accountId: string;
    title?: string;
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string | null;
  }): Promise<ThreadSummary | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      const summary = await client.call('threads.create', input);
      this.#upsertThread(summary);
      await this.open(summary.id);
      return summary;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  /**
   * The composer's one action. On a draft it creates the thread first, titled
   * from the prompt; on an open thread it starts a turn.
   */
  async submit(prompt: string, choice: Choice): Promise<void> {
    if (prompt.trim().length === 0) return;
    this.remember(choice);
    if (this.openThread) {
      await this.send(prompt);
      return;
    }
    const draft = this.draft;
    if (!draft) return;
    const created = await this.createThread({
      projectId: draft.projectId,
      providerId: choice.providerId,
      accountId: choice.accountId,
      permissionMode: choice.permissionMode,
      title: titleFrom(prompt) || undefined,
      effort: choice.effort,
      ...(choice.model ? { model: choice.model } : {})
    });
    if (created) await this.send(prompt);
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

  /**
   * `permission.requested` reaches a subscribed socket once and is gone. A page
   * that loads while a turn waits gets the same request from `permissions.list`,
   * so both paths land here and the same id never makes a second card.
   */
  #mergePermissions(requests: PermissionRequest[]): void {
    if (requests.length === 0) return;
    const byId = new Map(this.pendingPermissions.map((p) => [p.id, p] as const));
    for (const request of requests) byId.set(request.id, request);
    this.pendingPermissions = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.permissionRequests = {
      ...this.permissionRequests,
      ...Object.fromEntries(requests.map((request) => [request.id, request] as const))
    };
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

  async update(
    threadId: ThreadId,
    patch: { title?: string; model?: string; effort?: string | null; permissionMode?: PermissionMode }
  ): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const summary = await client.call('threads.update', { threadId, ...patch });
      this.#upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
    } catch (error) {
      this.#fail(error);
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    const open = this.openThread;
    if (!open) return;
    await this.update(open.id, { permissionMode: mode });
  }

  async rename(threadId: ThreadId, title: string): Promise<void> {
    const clean = title.trim();
    if (clean.length === 0) return;
    await this.update(threadId, { title: clean });
  }

  async archive(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('threads.archive', { threadId, archived: true });
      this.threads = this.threads.filter((t) => t.id !== threadId);
      if (this.openThread?.id === threadId) {
        this.openThread = null;
        await this.#unsubscribe();
        await this.openWhereLeft();
      }
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

  /** Start the provider's login for this account; the rest arrives as `account.login`. */
  async loginAccount(accountId: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('accounts.login', { accountId });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** One line into the running login, for a CLI that asks for a code to paste. */
  async sendLoginInput(accountId: string, text: string): Promise<void> {
    const client = this.#client;
    if (!client || text.trim().length === 0) return;
    try {
      await client.call('accounts.loginInput', { accountId, text: text.trim() });
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
  // Managed installs
  // -------------------------------------------------------------------------

  /** Start the download. The rest arrives as `providers.installProgress`. */
  async installProvider(providerId: ProviderId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const state = await client.call('providers.install', { providerId });
      this.installStates = { ...this.installStates, [providerId]: state };
    } catch (error) {
      this.#fail(error);
    }
  }

  async cancelInstall(providerId: ProviderId): Promise<void> {
    const client = this.#client;
    const state = this.installOf(providerId);
    if (!client || state === null || state.state === 'absent' || state.state === 'installed' || state.state === 'failed')
      return;
    try {
      await client.call('providers.installCancel', { providerId, operationId: state.operationId });
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Delete the files. Refused by the core while a process of that provider is alive. */
  async uninstallProvider(providerId: ProviderId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const state = await client.call('providers.uninstall', { providerId });
      this.installStates = { ...this.installStates, [providerId]: state };
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** What a project going away costs the UI, whether this client removed it or another did. */
  async #dropProject(projectId: ProjectId): Promise<void> {
    this.projects = this.projects.filter((p) => p.id !== projectId);
    this.threads = this.threads.filter((t) => t.projectId !== projectId);
    if (this.openThread?.projectId === projectId) this.openThread = null;
    if (this.draft?.projectId === projectId) this.draft = null;
    await this.openWhereLeft();
  }

  async #unsubscribe(): Promise<void> {
    const client = this.#client;
    const previous = this.#subscribedThreadId;
    if (!client || !previous) return;
    this.#subscribedThreadId = null;
    try {
      await client.call('threads.unsubscribe', { threadId: previous });
    } catch {
      /* the thread may already be gone */
    }
  }

  #upsertThread(summary: ThreadSummary): void {
    const index = this.threads.findIndex((t) => t.id === summary.id);
    if (index >= 0) this.threads[index] = summary;
    else this.threads.push(summary);
  }

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

  /** What was probed for one account, dropped: the account itself changed. */
  #dropProbes(accountId: string): void {
    const suffix = `::${accountId}`;
    const kept = Object.entries(this.probedModels).filter(([key]) => !key.endsWith(suffix));
    if (kept.length !== Object.keys(this.probedModels).length) {
      this.probedModels = Object.fromEntries(kept);
    }
  }

  #fail(error: unknown): void {
    if (error instanceof RpcFailure) this.error = `${error.message} (${error.code})`;
    else if (error instanceof Error) this.error = error.message;
    else this.error = String(error);
  }
}

export const store = new Store();
