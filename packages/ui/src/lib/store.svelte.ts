import { RpcErrorCode } from '@boite/contracts';
import { resetPullRequestSupport } from './pull-request';
import { activityCommand } from './activity-command';
import type {
  Account,
  CoreInfo,
  ImageAttachment,
  ImportableSession,
  Keybindings,
  KeybindingCommand,
  Message,
  MessageId,
  ModelInfo,
  PairedSession,
  PairingGrant,
  PairingRole,
  PermissionMode,
  PermissionRequest,
  Principal,
  QuestionRequest,
  ProcessRecord,
  Project,
  ProjectId,
  ProviderId,
  ProviderInstallState,
  ProviderRejected,
  ProviderSummary,
  RequestId,
  RpcEventName,
  RpcEvents,
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
import { clearStoredEndpoint, refreshLocalEnvironment, fromTauri, parsePairingLink, readEnvironments, removeEnvironment, resolveEndpoint, storeEndpoint, upsertEnvironment, type Endpoint, type StoredEnvironment } from './endpoint';
import { isExperimentEnabled } from './experiments';
import { titleFrom } from './format';
import { chordLabel, commandForKey, resolveBindings } from './keybindings';
import {
  readNotifications,
  requestNotificationPermission,
  sendNotification,
  shouldNotify,
  toastFor,
  writeNotifications,
  type NotifyKind
} from './notify';
import {
  clampSidebar,
  DRAFT_STASH_KEY,
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
import { DEFAULT_MODEL_NAMES, INITIAL_MODEL_DEFAULTS, readModelDefaults, writeModelDefaults, resolveModelDefault, type ModelDefaults } from './model-defaults';
import { FAVORITES_KEY, isNamedModel, readFavorites, type FavoriteModel } from './model-order';

export type Page = 'chat' | 'settings';
export type SettingsTab = 'voice' | 'general' | 'machines' | 'appearance' | 'keyboard' | 'accounts' | 'plugins' | 'usage' | 'resources' | 'experiments';

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
  /** The first send starts the thread in a git worktree of the project, on a branch of its own. */
  worktree: boolean;
}

/** What the composer sends a message with. */
export interface Choice {
  providerId: ProviderId;
  accountId: string;
  permissionMode: PermissionMode;
  model: string | null;
  /** A level id of that model, or null for the model's own default. */
  effort: string | null;
  speed?: string | null;
}

/** What the picker hands back: the instance and model together, or an effort alone. */
export interface PickPatch {
  providerId?: ProviderId;
  accountId?: string;
  model?: string | null;
  effort?: string | null;
  speed?: string | null;
}

export const UI_VERSION = '2.0.0-beta.1';

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

/**
 * The requests of one thread, or of none. The same object comes back when there
 * was nothing to drop, so a filter that changes nothing re-renders nothing.
 */
function requestsOf<T extends { threadId: ThreadId }>(
  records: Record<RequestId, T>,
  keep: (threadId: ThreadId) => boolean
): Record<RequestId, T> {
  const kept: Record<RequestId, T> = {};
  let dropped = false;
  for (const [id, record] of Object.entries(records)) {
    if (keep(record.threadId)) kept[id] = record;
    else dropped = true;
  }
  return dropped ? kept : records;
}

/**
 * What a list of requests speaks for: every thread (`reload()`), one thread
 * (`open()`), or nothing but itself, which is one event arriving.
 */
type RequestScope = ThreadId | 'all' | 'one';

/** True while `scope` says nothing about this request, so it is kept as it is. */
function outside(request: { threadId: ThreadId }, scope: RequestScope): boolean {
  if (scope === 'one') return true;
  if (scope === 'all') return false;
  return request.threadId !== scope;
}

/** A pid alone is reused by the OS, so a trace row is a pid and its start. */
function sameProcess(a: ProcessRecord, b: ProcessRecord): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

const LIVE: ThreadStatusRank = { waiting: 0, running: 1, queued: 2, error: 3, idle: 4 };
type ThreadStatusRank = Record<ThreadSummary['status'], number>;

export class Store {
  readonly readingPositions = new Map<string, { top: number; pinned: boolean; heights: Map<string, number>; anchor?: { id: string; offset: number } }>();
  #readingThreads = new Map<string, Thread>();
  private rememberReadingThread(): void {
    const thread = this.openThread;
    if (!thread) return;
    // Four recent timelines, with at most 4 MB of text/image data each.
    // The active timeline remains unrestricted; old visits must not retain every image forever.
    let bytes = 0;
    for (const message of thread.messages) for (const part of message.parts) {
      // Include nested tool inputs and documents, with conservative JSON overhead.
      bytes += JSON.stringify(part).length * 2;
    }
    this.#readingThreads.delete(thread.id);
    if (bytes <= 4 * 1024 * 1024 && thread.messages.length <= 2000) this.#readingThreads.set(thread.id, thread);
    while (this.#readingThreads.size > 4) this.#readingThreads.delete(this.#readingThreads.keys().next().value!);
  }
  #pendingSends = new Map<string, { id: string; prompt: string; attachments: ImageAttachment[]; selectionVersion: number }>();
  machineId = '';
  visible = true;
  threadKey(id: string): string { return this.machineId ? JSON.stringify([this.machineId, id]) : id; }
  connection = $state<ClientState>('idle');
  core = $state<CoreInfo | null>(null);
  /** Owner on the core token, session on a paired one; what decides who may pair a phone. */
  principal = $state<Principal | null>(null);
  /** The last one-time pairing link minted from Settings, until the page changes. */
  pairing = $state<PairingGrant | null>(null);
  sessions = $state<PairedSession[]>([]);
  /** The address of the core this UI talks to; null on the fake client. */
  endpointUrl = $state<string | null>(null);
  /** This UI holds the key a pairing link became, not a token read off the machine. */
  paired = $state(false);
  /** The core is the one the shell started on this computer. */
  localCore = $state(false);
  localEndpointUrl = $state<string | null>(null);
  /** The cores this device remembers: pairing or connecting adds one, forgetting removes one. */
  environments = $state<StoredEnvironment[]>([]);
  projectPickerOpen = $state(false);
  machineStates = $state<Record<string, { state: ClientState; error?: string }>>({});
  /** Toasts for threads the user is not looking at, per machine. */
  notifications = $state(readNotifications());
  /** The command palette, `Ctrl+K`. */
  paletteOpen = $state(false);
  /** Set by the palette's Rename: the chat header opens its title field and clears it. */
  renameRequested = $state(false);
  /** The threads a `threads.retitle` is out for: their menu item waits. */
  retitling = $state<ThreadId[]>([]);
  /** The import dialog while it is open: the project, what `imports.list` found, the session being imported. */
  imports = $state<{ projectId: ProjectId; sessions: ImportableSession[]; loading: boolean; running: string | null } | null>(null);
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
  /**
   * The open thread holds the window that is loaded, not the whole history:
   * `threads.get` gives the last page and `loadOlder` prepends what is above it.
   */
  openThread = $state<Thread | null>(null);
  /** True while a page of older messages is in flight, so the timeline can say so. */
  loadingOlder = $state(false);
  draft = $state<Draft | null>(null);
  prefs = $state<ComposerPrefs>(defaultPrefs());
  modelDefaults = $state<ModelDefaults>({});
  draftChoice = $state<Choice | null>(null);
  favorites = $state<FavoriteModel[]>(readFavorites());

  toggleFavorite(providerId: string, accountId: string, model: ModelInfo): void {
    const matches = (f: FavoriteModel) => f.providerId === providerId && f.accountId === accountId && f.model.id === model.id;
    this.favorites = this.favorites.some(matches) ? this.favorites.filter((f) => !matches(f))
      : [...this.favorites, { providerId, accountId, model }];
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(this.favorites)); } catch { /* session only */ }
  }

  async compact(): Promise<void> {
    const thread = this.openThread;
    if (!thread || !this.#client) return;
    try { await this.#client.call('threads.compact', { threadId: thread.id, expectedSelectionVersion: thread.selectionVersion ?? 0 }); }
    catch (error) { this.#fail(error); }
  }
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
   * One entry per provider and account the picker has opened this session, which
   * is what bounds it: the pairs exist on the machine, they do not arrive with
   * time, and an account that changes drops its own key.
   */
  probedModels = $state<Record<string, ModelInfo[]>>({});
  #probeAttempts = new Set<string>();
  #probeRequests = new Map<string, Promise<void>>();
  #probeEpoch = 0;
  #modelCacheKey(): string { return 'boite.models.v1:' + JSON.stringify([this.endpointUrl, this.core?.dataDir]); }
  #saveModels(): void {
    try { localStorage.setItem(this.#modelCacheKey(), JSON.stringify({ providers: this.providers, accounts: this.accounts, models: this.probedModels })); }
    catch { /* Storage unavailable: keep the in-memory cache. */ }
  }
  #restoreModels(): void {
    try {
      const cached = JSON.parse(localStorage.getItem(this.#modelCacheKey()) ?? 'null');
      if (!cached || JSON.stringify(cached.providers) !== JSON.stringify(this.providers) || JSON.stringify(cached.accounts) !== JSON.stringify(this.accounts)) return;
      const entries = Object.entries(cached.models ?? {}).filter(([, models]) => Array.isArray(models) && models.every(m => typeof m?.id === 'string' && typeof m?.name === 'string'));
      this.probedModels = { ...Object.fromEntries(entries) as Record<string, ModelInfo[]>, ...this.probedModels };
    } catch { /* A missing or malformed cache is read again from the agent. */ }
  }
  /** The keys a probe is running for, so the picker can say it is reading. */
  probingModels = $state<string[]>([]);
  accounts = $state<Account[]>([]);
  /** Keyed by account id: one entry while a login runs, and after one failed. */
  logins = $state<Record<string, LoginState>>({});
  scheduler = $state<SchedulerState | null>(null);
  settings = $state<Settings | null>(null);
  /** The keybindings file as the core last read it; null until the first `keybindings.get`. */
  keybindings = $state<Keybindings | null>(null);
  /** Every command with its chord: the defaults, the file's entries over them. */
  bindings = $derived(resolveBindings(this.keybindings?.bindings ?? {}));
  resources = $state<ThreadResources[]>([]);
  usage = $state<UsageReport | null>(null);
  trace = $state<ProcessRecord[]>([]);
  pendingPermissions = $state<PermissionRequest[]>([]);
  /**
   * Kept after the answer so a resolved card still shows what was asked. Only
   * the open thread has cards on the screen, so only its entries are held: this
   * record grew for the life of the page before that.
   */
  permissionRequests = $state<Record<RequestId, PermissionRequest>>({});
  pendingQuestions = $state<QuestionRequest[]>([]);
  /** Kept after the answer so a folded card still shows what was asked. Same bound. */
  questionRequests = $state<Record<RequestId, QuestionRequest>>({});
  collapsedProjects = $state<string[]>([]);

  #client: Client | null = null;
  #off: (() => void)[] = [];
  #subscribedThreadId: ThreadId | null = null;
  /** The number of the newest `open()`, so an older one writes nothing. */
  #openGeneration = 0;
  /** What that newest run is opening, so an older one knows what to give back. */
  #openTarget: ThreadId | null = null;
  /** The load in flight, so the two callers of `reload()` share one. */
  #reloading: Promise<void> | null = null;
  #loginRevision = 0;
  #loginChanges = new Map<string, number>();

  get client(): Client | null {
    return this.#client;
  }

  /**
   * What this client may ask of the core. A paired device reaches the list in
   * `packages/core/src/access.ts` and nothing else, so everything outside it
   * comes off its screen rather than throwing under a finger. The `null` of a
   * `hello` still in flight counts as the owner: the desktop must not blink its
   * own controls away, and a phone showing one for a frame is the cheaper miss.
   */
  get owner(): boolean {
    return this.principal !== 'session';
  }

  /**
   * The native folder dialog names a path on this computer, which is only a
   * path the core can open when the core runs here too. A shell paired with a
   * core on a server types the server's path instead.
   */
  get pickerAvailable(): boolean {
    return window.__TAURI_INTERNALS__ !== undefined && this.localCore;
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

  /** Pinned threads first, then the live ones, then by last activity; the search box narrows it. */
  sortedThreadsOf(projectId: ProjectId): ThreadSummary[] {
    const needle = this.search.trim().toLowerCase();
    return this.threadsOf(projectId)
      .filter((t) => needle === '' || t.title.toLowerCase().includes(needle))
      .sort(
        (a, b) =>
          Number(b.pinned) - Number(a.pinned) || LIVE[a.status] - LIVE[b.status] || b.updatedAt - a.updatedAt
      );
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
    if (probed) return probed;
    const provider = this.providerOf(providerId);
    const models = provider?.models ?? [];
    return provider?.protocol === 'claude-sdk' ? models.map(({ effort, speeds, ...model }) => model) : models;
  }

  /** The model a choice runs on, out of what its own instance offers: what the chips read. */
  modelOf(choice: Choice | null): ModelInfo | null {
    if (!choice) return null;
    const offered = this.modelsOf(choice.providerId, choice.accountId).find((m) => m.id === choice.model);
    if (offered) return offered;
    const preferred = this.modelDefaults[choice.providerId] ?? INITIAL_MODEL_DEFAULTS[choice.providerId];
    // Display the configured target before probing. It never joins modelsOf's selectable list.
    return choice.model && choice.model === preferred?.model
      ? { id: choice.model, name: DEFAULT_MODEL_NAMES[choice.model] ?? choice.model } : null;
  }

  isProbing(providerId: ProviderId, accountId: string | null): boolean {
    return accountId !== null && this.probingModels.includes(probeKey(providerId, accountId));
  }

  /**
   * Ask the agent what it can run. Once per instance per session: the answer
   * stays until the core reloads its descriptors or the account changes.
   */
  probeModels(providerId: ProviderId, accountId: string, refresh = false): Promise<void> {
    const client = this.#client;
    const key = probeKey(providerId, accountId);
    const existing = this.#probeRequests.get(key);
    if (existing) return existing;
    if (!client || !this.owner || (!refresh && this.#probeAttempts.has(key))) return Promise.resolve();
    this.#probeAttempts.add(key);
    const epoch = this.#probeEpoch;
    this.probingModels = [...this.probingModels, key];
    let request!: Promise<void>;
    request = (async () => {
      try {
        const { models } = await client.call('providers.probe', { providerId, accountId, ...(refresh ? { refresh: true } : {}) });
        if (client !== this.#client || epoch !== this.#probeEpoch) return;
        this.probedModels = { ...this.probedModels, [key]: models };
        this.#saveModels();
      } catch (error) { if (client === this.#client) this.#fail(error); }
      finally {
        if (this.#probeRequests.get(key) === request) {
          this.#probeRequests.delete(key);
          this.probingModels = this.probingModels.filter(entry => entry !== key);
        }
      }
    })();
    this.#probeRequests.set(key, request);
    return request;
  }

  isCollapsed(projectId: ProjectId): boolean {
    return this.collapsedProjects.includes(projectId);
  }

  toggleProject(projectId: ProjectId): void {
    this.collapsedProjects = this.isCollapsed(projectId)
      ? this.collapsedProjects.filter((id) => id !== projectId)
      : [...this.collapsedProjects, projectId];
  }

  defaultModelOf(provider: ProviderSummary, accountId?: string): string | null {
    const models = accountId ? this.modelsOf(provider.id, accountId) : provider.models;
    const preferred = this.modelDefaults[provider.id] ?? INITIAL_MODEL_DEFAULTS[provider.id];
    return preferred?.model ?? resolveModelDefault(provider.id, models, this.modelDefaults)?.model ?? null;
  }

  /** Replace old agent-selected aliases for the next prompt, preserving named choices. */
  composerChoice(choice: Choice): Choice {
    const offered = this.modelOf(choice);
    if (choice.model && isNamedModel(offered ?? { id: choice.model, name: choice.model })) return choice;
    const provider = this.providerOf(choice.providerId);
    if (!provider) return choice;
    const model = this.defaultModelOf(provider, choice.accountId);
    return { ...choice, model, effort: this.defaultEffortOf(provider.id, choice.accountId, model), speed: null };
  }

  defaultEffortOf(providerId: string, accountId: string, model: string | null): string | null {
    const offered = this.modelsOf(providerId, accountId);
    const configured = this.modelDefaults[providerId] ?? INITIAL_MODEL_DEFAULTS[providerId];
    if (configured?.model === model && (!offered.some((entry) => entry.id === model) ||
      (this.providerOf(providerId)?.protocol === 'claude-sdk' && !this.probedModels[probeKey(providerId, accountId)]))) return configured.effort;
    const preferred = resolveModelDefault(providerId, offered, this.modelDefaults);
    return preferred?.model === model ? preferred.effort : offered.find((m) => m.id === model)?.effort?.default ?? null;
  }

  setModelDefault(providerId: string, accountId: string, model: string, effort: string | null): void {
    const offered = this.modelsOf(providerId, accountId).find((m) => m.id === model);
    if (!offered || !isNamedModel(offered)) return;
    const validEffort = offered.effort?.levels.some((level) => level.id === effort) ? effort : offered.effort?.default ?? null;
    this.modelDefaults = { ...this.modelDefaults, [providerId]: { model, effort: validEffort } };
    writeModelDefaults(this.modelDefaults);
  }

  /**
   * What the composer opens on: the remembered provider and account when they
   * still exist, else the first available provider and its first account.
   */
  defaultChoice(): Choice | null {
    if (this.draft && this.draftChoice) return this.draftChoice;
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
    const model = this.defaultModelOf(provider, account.id);
    const effort = this.defaultEffortOf(provider.id, account.id, model);
    return {
      providerId: provider.id,
      accountId: account.id,
      permissionMode: this.prefs.permissionMode,
      model,
      effort,
      speed: this.modelsOf(provider.id, account.id).find(m => m.id === model)?.speeds?.some(option => option.id === this.prefs.speed) ? this.prefs.speed : null
    };
  }

  remember(choice: Choice): void {
    if (this.draft) this.draftChoice = { ...choice };
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
    this.#readingThreads.clear();
    this.readingPositions.clear();
    this.#pendingSends.clear();
    this.logins = {};
    this.#loginChanges.clear();
    this.#client = client;
    this.probedModels = {};
    this.#probeEpoch++;
    this.#probeAttempts.clear();
    this.#probeRequests.clear();
    this.probingModels = [];
    this.connection = client.state;
    this.prefs = readPrefs();
    this.modelDefaults = readModelDefaults();
    this.favorites = readFavorites();
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
            resetPullRequestSupport(client);
            this.#probeEpoch++;
            this.#probeAttempts.clear();
            this.error = null;
            this.core = client.core;
            // `WsClient` writes its principal from the hello answer before it
            // reports `ready`, and this handler runs before `connect()` returns:
            // reading it here is what keeps the owner-only calls out of the very
            // first load, and what refreshes it after a reconnect.
            this.principal = client.principal;
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
    // The agent's `/name` list is the whole list each time, and it lives on the
    // open thread only: a summary in the sidebar carries none.
    on('thread.commands', ({ threadId, commands }) => {
      const open = this.openThread;
      if (open && open.id === threadId) open.commands = commands;
    });
    on('thread.activity', ({ threadId, activity }) => {
      if (this.openThread?.id === threadId) this.openThread.activity = activity;
    });
    on('thread.removed', ({ threadId }) => {
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.#dropRequestsOf(threadId);
      // A thread that left Boite takes its panel layout with it.
      rightPanel.forget(this.threadKey(threadId));
      if (this.openThread?.id !== threadId) return;
      this.openThread = null;
      // The two steps `archive()` takes when the thread on screen goes: the
      // socket lets it go, and the chat lands on the next thread rather than
      // on the empty card.
      void (async () => {
        await this.#unsubscribe();
        await this.openWhereLeft();
      })();
    });

    on('turn.started', (turn) => this.#upsertTurn(turn.threadId, turn));
    on('turn.finished', (turn) => {
      this.#upsertTurn(turn.threadId, turn);
      void this.refreshUsage();
      // A stop is the user's own doing: nothing to tell them.
      if (turn.status === 'done') this.#notify('done', turn.threadId, null);
      else if (turn.status === 'error') this.#notify('error', turn.threadId, turn.error);
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
      this.#mergePermissions([request], 'one');
      this.#notify('needs-you', request.threadId, null);
    });
    on('permission.resolved', ({ requestId }) => {
      this.pendingPermissions = this.pendingPermissions.filter((p) => p.id !== requestId);
    });

    on('question.asked', (request) => {
      this.#mergeQuestions([request], 'one');
      this.#notify('needs-you', request.threadId, null);
    });
    on('question.answered', ({ questionId }) => {
      this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== questionId);
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
      this.#loginChanges.set(event.accountId, ++this.#loginRevision);
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
      this.#loginChanges.set(accountId, ++this.#loginRevision);
      const { [accountId]: _gone, ...rest } = this.logins;
      this.logins = rest;
      this.#dropProbes(accountId);
    });
    on('settings.updated', (settings) => {
      this.settings = settings;
    });
    on('keybindings.updated', (keybindings) => {
      this.keybindings = keybindings;
    });
    on('sessions.updated', () => {
      if (this.page === 'settings') void this.loadSessions();
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
      this.#probeEpoch++;
      this.#probeAttempts.clear();
      this.#saveModels();
    });
    on('providers.probed', ({ providerId, accountId, models }) => {
      this.probedModels = { ...this.probedModels, [probeKey(providerId, accountId)]: models };
      this.#probeAttempts.add(probeKey(providerId, accountId));
      this.#saveModels();
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

  /** Stop streaming the hidden conversation while keeping machine summaries live. */
  async suspend(): Promise<void> {
    this.visible = false;
    this.#openGeneration++;
    await this.#unsubscribe();
  }

  async connectEndpoint(endpoint: Endpoint): Promise<void> {
    this.#attachEndpoint(endpoint, false);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.connect(), new Promise<void>(resolve => {
        timeout = setTimeout(() => { this.error = strings.machines.timeout; this.#client?.close(); resolve(); }, 12_000);
      })]);
    } finally { clearTimeout(timeout); this.booted = true; }
  }

  /** Picks the transport, connects, loads everything the UI opens on. */
  async boot(preferLocal = false): Promise<void> {
    try {
      this.environments = readEnvironments();
      const params = new URLSearchParams(window.location.search);
      // `import.meta.env.DEV` is a constant the bundler folds, so a production
      // build drops this branch whole and never carries the fake core, which
      // is a seeded copy of the app's data. It is true under vite's dev server
      // and under vitest, the two places `?fake=1` is used.
      if (import.meta.env.DEV && params.get('fake') === '1') {
        this.machineId = '';
        this.endpointUrl = null;
        this.localCore = false;
        this.paired = false;
        const { FakeClient } = await import('./fake-client');
        // `&long=1` adds the four-hundred-message thread the windowed list is
        // looked at on, `&principal=session` answers as a paired phone, so the
        // screens a device is refused can be walked without pairing one.
        this.attach(
          new FakeClient({
            long: params.get('long') === '1',
            uninstalled: params.get('uninstalled') === '1',
            ...(params.get('principal') === 'session' ? { principal: 'session' as const } : {})
          })
        );
      } else {
        if (window.__TAURI_INTERNALS__) {
          const local = await fromTauri();
          if (local) {
            this.localEndpointUrl = local.url;
            this.environments = refreshLocalEnvironment(local);
          }
        }
        const endpoint = await resolveEndpoint(preferLocal);
        if (!endpoint) {
          this.connection = 'closed';
          this.booted = true;
          return;
        }
        this.machineId = endpoint.url;
        this.#attachEndpoint(endpoint);
      }
      await this.connect();
      await this.openWhereLeft();
    } finally {
      this.booted = true;
    }
  }

  #attachEndpoint(endpoint: Endpoint, rememberActive = true): void {
    const url = endpoint.url;
    this.machineId = endpoint.local ? 'local' : url;
    const paired = endpoint.paired === true || endpoint.grant !== undefined;
    this.endpointUrl = url;
    this.paired = paired;
    this.localCore = endpoint.local === true;
    this.attach(
      new WsClient({
        url,
        token: endpoint.token,
        ...(endpoint.grant === undefined ? {} : { grant: endpoint.grant }),
        paired,
        // The session a grant became is this device's own credential: kept
        // where the next load reads it, so the link is opened once, ever.
        // The core joins the remembered environments with it, so switching
        // back later needs no new link.
        onSession: (session) => {
          if (rememberActive) storeEndpoint({ url, token: session.token, paired: true });
          this.environments = upsertEnvironment({ url, token: session.token, paired: true });
        },
        // Revoked from the desktop: the dead key goes here and in the
        // remembered cores, and the page says what to do rather than
        // retrying every ten seconds.
        onRevoked: () => {
          if (rememberActive) clearStoredEndpoint();
          this.environments = removeEnvironment(url);
          this.connection = 'closed';
          this.error = strings.errors.revoked;
        },
        clientName: window.__TAURI_INTERNALS__ === undefined ? 'pwa' : 'shell',
        version: UI_VERSION
      })
    );
  }

  /** Drops everything the last core said, then connects to the next one. */
  async #switchTo(endpoint: Endpoint): Promise<void> {
    this.#client?.close();
    this.detach();
    this.openThread = null;
    this.draft = null;
    this.pairing = null;
    this.sessions = [];
    this.projects = [];
    this.threads = [];
    this.principal = null;
    this.core = null;
    this.#attachEndpoint(endpoint);
    await this.connect();
    await this.openWhereLeft();
  }

  /** The most recent thread, a draft in the first project, or nothing on a first run. */
  async openWhereLeft(): Promise<void> {
    if (!this.visible) return;
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
      this.principal = client.principal;
      this.error = null;
      await this.reload();
    } catch (error) {
      this.connection = client.state;
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // Pairing: the owner mints one-time links, sees every paired device, revokes.
  // -------------------------------------------------------------------------

  async mintPairing(role: PairingRole = 'device'): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.pairing = await client.call('pairing.grant', { role });
    } catch (error) {
      this.#fail(error);
    }
  }

  async loadSessions(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.sessions = await client.call('sessions.list', {});
    } catch (error) {
      this.#fail(error);
    }
  }

  async revokeSession(sessionId: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('sessions.revoke', { sessionId });
      this.sessions = this.sessions.filter((session) => session.id !== sessionId);
    } catch (error) {
      this.#fail(error);
    }
  }

  /** Point the UI at another core, from the Settings page. It stays remembered. */
  async connectTo(url: string, token: string): Promise<void> {
    storeEndpoint({ url, token });
    this.environments = upsertEnvironment({ url, token, paired: false });
    await this.#switchTo({ url, token });
  }

  /** Drive a remembered core with the key the pairing left here. No new link needed. */
  async switchEnvironment(url: string): Promise<void> {
    if (url === this.localEndpointUrl) return this.useLocalCore();
    const env = readEnvironments().find((entry) => entry.url === url);
    if (!env) {
      this.error = strings.errors.noEndpoint;
      return;
    }
    storeEndpoint({ url: env.url, token: env.token, ...(env.paired ? { paired: true } : {}) });
    await this.#switchTo({ url: env.url, token: env.token, ...(env.paired ? { paired: true } : {}) });
  }

  /**
   * Drop a remembered core from this device. Its key stays valid there until
   * revoked; forgetting the core under the UI falls back to the local one.
   */
  async forgetEnvironment(url: string): Promise<void> {
    this.environments = removeEnvironment(url);
    if (this.endpointUrl === url) await this.useLocalCore();
  }

  /**
   * Pair this app with a core that runs elsewhere, from a link that core
   * minted. The grant is spent on the first hello and the key it becomes is
   * stored in its place; in the shell that key wins over the core the shell
   * started, on every launch, until `useLocalCore`.
   */
  async pairWith(link: string): Promise<boolean> {
    const parsed = parsePairingLink(link);
    if (!parsed) {
      this.error = strings.errors.pairingLink;
      return false;
    }
    await this.#switchTo({ url: parsed.url, token: '', grant: parsed.grant });
    return this.connection === 'ready';
  }

  /** Back to the core this shell started. Remembered cores stay remembered. */
  async useLocalCore(): Promise<void> {
    clearStoredEndpoint();
    const endpoint = await resolveEndpoint();
    if (!endpoint) {
      this.#client?.close();
      this.detach();
      this.connection = 'closed';
      this.error = strings.errors.noEndpoint;
      return;
    }
    await this.#switchTo(endpoint);
  }

  /**
   * `connect()` and the `ready` state handler both ask for this on every boot
   * and on every reconnect, and the second one used to send the same ten calls
   * again. It joins the load already in flight instead.
   */
  reload(): Promise<void> {
    this.#reloading ??= this.#load().finally(() => {
      this.#reloading = null;
    });
    return this.#reloading;
  }

  async #load(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const loginRevision = this.#loginRevision;
    try {
      const [projects, threads, providers, accounts, settings, scheduler, permissions, questions, logins, keybindings] =
        await Promise.all([
          client.call('projects.list', {}),
          client.call('threads.list', {}),
          client.call('providers.list', {}),
          client.call('accounts.list', {}),
          client.call('settings.get', {}),
          client.call('scheduler.get', {}),
          client.call('permissions.list', {}),
          client.call('questions.list', {}),
          // The one owner-only call of the boot. A device asking for it is
          // refused, and `Promise.all` would take the whole load down with it,
          // so the phone would come up on an empty app and a red toast.
          this.owner ? client.call('accounts.logins', {}) : Promise.resolve([]),
          client.call('keybindings.get', {})
        ]);
      this.#mergePermissions(permissions, 'all');
      this.#mergeQuestions(questions, 'all');
      this.projects = projects;
      this.threads = threads;
      this.providers = providers.loaded;
      this.rejectedProviders = providers.rejected;
      this.installStates = installStatesOf(providers.loaded);
      this.accounts = accounts;
      this.#restoreModels();
      this.#restoreLogins(logins, loginRevision);
      this.settings = settings;
      this.keybindings = keybindings;
      this.scheduler = scheduler;
      const open = this.openThread;
      if (open && this.visible) await this.open(open.id, false);
    } catch (error) {
      this.#fail(error);
    }
  }

  // -------------------------------------------------------------------------
  // The keyboard
  // -------------------------------------------------------------------------

  /** The command this keydown is bound to, or null when the key is nobody's. */
  commandForKey(event: KeyboardEvent): KeybindingCommand | null {
    return commandForKey(this.bindings, event);
  }

  /** True while this keydown is the chord of that one command. */
  isKey(event: KeyboardEvent, id: KeybindingCommand): boolean {
    return this.commandForKey(event) === id;
  }

  /** `Ctrl+N`, or null while the command has no key. */
  keyLabel(id: KeybindingCommand): string | null {
    const chord = this.bindings[id].chord;
    return chord === null ? null : chordLabel(chord);
  }

  /** ` (Ctrl+N)` for a tooltip, or nothing while the command has no key. */
  keyHint(id: KeybindingCommand): string {
    const label = this.keyLabel(id);
    return label === null ? '' : ` (${label})`;
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
    return rightPanel.for(this.openThread ? this.threadKey(this.openThread.id) : null);
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
    if (!this.pickerAvailable) return null;
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

  browseProjects(path?: string) {
    if (!this.#client) throw new Error(strings.errors.noEndpoint);
    return this.#client.call('projects.browse', path ? { path } : {});
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
    // Explorer paths belong to this computer even while a remote core is open.
    if (window.__TAURI_INTERNALS__ && !this.localCore) await this.useLocalCore();
    if (!this.owner || this.connection !== 'ready') return;
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
    this.rememberReadingThread();
    void this.#unsubscribe();
    this.openThread = null;
    this.draftChoice = null;
    this.trace = [];
    this.#keepRequestsOf(null);
    this.draft = { projectId: target, worktree: false };
    this.page = 'chat';
    this.sidebarOpen = false;
  }

  /**
   * The draft moves to another project. Everything reading it follows on its
   * own (`openProject`, the composer's placeholder, the sidebar group), and a
   * folded project is opened, because a draft nobody can see is a lost draft.
   */
  setDraftProject(projectId: ProjectId): void {
    const draft = this.draft;
    if (!draft || draft.projectId === projectId) return;
    if (!this.projects.some((p) => p.id === projectId)) return;
    this.draft = { projectId, worktree: draft.worktree };
    this.collapsedProjects = this.collapsedProjects.filter((id) => id !== projectId);
  }

  /** The draft's worktree switch: on, the first send asks the core for a branch and a worktree. */
  setDraftWorktree(worktree: boolean): void {
    const draft = this.draft;
    if (!draft || draft.worktree === worktree) return;
    this.draft = { ...draft, worktree };
  }

  /**
   * Two clicks inside one round trip are one thread: the newest run owns the
   * screen and the subscription, and an older one writes nothing, not even
   * `#subscribedThreadId`. The order is subscribe then unsubscribe, so a
   * refused subscribe leaves the thread on screen with the socket it had
   * rather than with none at all.
   */
  async open(threadId: ThreadId, navigate = true): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const generation = ++this.#openGeneration;
    this.#openTarget = threadId;
    const newest = (): boolean => this.#openGeneration === generation;
    try {
      const previous = this.#subscribedThreadId;
      await client.call('threads.subscribe', { threadId });
      if (!newest()) {
        // A newer click took over while this one was in flight. Its own thread
        // is the one the socket keeps, so this subscription goes back.
        if (this.#openTarget !== threadId) {
          await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
        }
        return;
      }
      this.#subscribedThreadId = threadId;
      if (previous && previous !== threadId) {
        await client.call('threads.unsubscribe', { threadId: previous });
      }
      const thread = await client.call('threads.get', { threadId });
      if (!newest()) return;
      this.rememberReadingThread();
      const cached = this.#readingThreads.get(threadId);
      const freshIds = new Set(thread.messages.map(m => m.id));
      if (cached && cached.messages.some(m => freshIds.has(m.id))) {
        const merged = new Map(cached.messages.map(m => [m.id, m]));
        for (const message of thread.messages) merged.set(message.id, message);
        thread.messages = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
        thread.messagesBefore = cached.messagesBefore;
      } else {
        this.#readingThreads.delete(threadId);
        this.readingPositions.delete(threadId);
      }
      this.draft = null;
      // The last page, pinned to the bottom; what is above it arrives on scroll.
      this.loadingOlder = false;
      this.openThread = thread;
      // The thread that was open takes its permission and question cards with it.
      this.#keepRequestsOf(threadId);
      if (navigate) {
        this.page = 'chat';
        this.sidebarOpen = false;
      }
      // The trace is the owner's: a device has no button for it, and asking
      // would refuse the rest of this open with it.
      const trace = this.owner ? await client.call('trace.get', { threadId }) : [];
      if (!newest()) return;
      this.trace = trace;
      // The thread may already be waiting on a request this page never saw,
      // and may have had one settled where this client could not hear it.
      const permissions = await client.call('permissions.list', { threadId });
      const questions = await client.call('questions.list', { threadId });
      if (!newest()) return;
      this.#mergePermissions(permissions, threadId);
      this.#mergeQuestions(questions, threadId);
      if (thread.unread) {
        await client.call('threads.markRead', { threadId });
        thread.unread = false;
        this.threads = this.threads.map((t) => (t.id === threadId ? { ...t, unread: false } : t));
      }
    } catch (error) {
      if (newest()) this.#fail(error);
    }
  }

  /** The cursor above the loaded window, null when the first message is already in hand. */
  get messagesBefore(): MessageId | null {
    return this.openThread?.messagesBefore ?? null;
  }

  /**
   * One page of messages older than the window, prepended in place. Nothing
   * happens without a cursor or while a page is already in flight, and a page
   * that lands on a thread the user has left is dropped. Returns how many
   * messages landed, so the caller can put their height back into `scrollTop`.
   */
  async loadOlder(): Promise<number> {
    const client = this.#client;
    const open = this.openThread;
    if (!client || !open) return 0;
    const cursor = open.messagesBefore;
    if (cursor === null || this.loadingOlder) return 0;
    this.loadingOlder = true;
    try {
      const page = await client.call('messages.list', { threadId: open.id, before: cursor });
      const still = this.openThread;
      if (!still || still.id !== open.id || still.messagesBefore !== cursor) return 0;
      const known = new Set(still.messages.map((m) => m.id));
      const older = page.messages.filter((m) => !known.has(m.id));
      still.messages.unshift(...older);
      const knownTurns = new Set(still.turns.map((turn) => turn.id));
      still.turns.push(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
      still.messagesBefore = page.before;
      return older.length;
    } catch (error) {
      this.#fail(error);
      return 0;
    } finally {
      this.loadingOlder = false;
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
    speed?: string | null;
    worktree?: { branch?: string };
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
   * Unsent prompts survive thread switches and the settings page, images and
   * all: a prompt queued while a turn runs keeps the pictures it was written
   * with, so the pair goes out together when its turn comes.
   */
  composerStates = $state<Record<string, {
    text: string;
    attachments: ImageAttachment[];
    queued: { text: string; attachments: ImageAttachment[] }[];
    sending: boolean;
    paused: boolean;
  }>>({});

  /**
   * The composer's one action. On a draft it creates the thread first, titled
   * from the prompt; on an open thread it starts a turn. An image alone is a
   * turn too, so an empty prompt with an attachment goes out.
   */
  async prepareDraftChoice(choice: Choice): Promise<Choice | null> {
    const provider = this.providerOf(choice.providerId);
    if (!choice.model || !provider) return choice;
    const models = this.modelsOf(choice.providerId, choice.accountId);
    if ((!models.some((model) => model.id === choice.model) ||
      (provider.protocol === 'claude-sdk' && !this.probedModels[probeKey(provider.id, choice.accountId)])) &&
      ['claude-sdk', 'acp', 'codex-appserver', 'pi'].includes(provider.protocol)) {
      const client = this.#client;
      if (!client) return null;
      try {
        const result = await client.call('providers.probe', { providerId: choice.providerId, accountId: choice.accountId });
        this.probedModels = { ...this.probedModels, [probeKey(choice.providerId, choice.accountId)]: result.models };
      } catch (error) { this.#fail(error); return null; }
    }
    if (!this.modelsOf(provider.id, choice.accountId).some((model) => model.id === choice.model)) {
      this.error = strings.settings.modelDefaultUnavailable.replace('{model}', choice.model).replace('{provider}', provider.name);
      return null;
    }
    return choice;
  }

  async submit(prompt: string, choice: Choice, attachments: ImageAttachment[] = []): Promise<boolean> {
    if ((prompt.trim().length === 0 && attachments.length === 0) || this.connection !== 'ready') return false;
    try {
      if (activityCommand(prompt) && attachments.length) throw new Error(strings.activity.noAttachments);
    } catch (error) { this.#fail(error); return false; }
    if (this.draft && !this.openThread) {
      const draft = this.draft;
      const selection = this.draftChoice;
      const prepared = await this.prepareDraftChoice(choice);
      if (!prepared || this.draft !== draft || this.draftChoice !== selection || this.openThread) return false;
      choice = prepared;
    }
    this.remember(choice);
    if (this.openThread) {
      return this.send(prompt, this.openThread.id, attachments);
    }
    const draft = this.draft;
    if (!draft) return false;
    const composer = this.composerStates[DRAFT_STASH_KEY];
    const created = await this.createThread({
      projectId: draft.projectId,
      providerId: choice.providerId,
      accountId: choice.accountId,
      permissionMode: choice.permissionMode,
      title: titleFrom(prompt) || undefined,
      effort: choice.effort,
      speed: choice.speed ?? null,
      ...(choice.model ? { model: choice.model } : {}),
      ...(draft.worktree ? { worktree: {} } : {})
    });
    if (!created) return false;
    if (composer) {
      this.composerStates[created.id] = composer;
      delete this.composerStates[DRAFT_STASH_KEY];
    }
    return this.send(prompt, created.id, attachments);
  }

  /**
   * Ctrl+Enter: the same send, then a fresh draft in the same project. The
   * choice is what `submit` already remembered, so the draft's composer opens
   * on the provider, account, model, effort and mode the prompt just went out
   * with. The draft waits for the send, because creating a thread from a draft
   * opens it and would otherwise take the new draft's place.
   */
  async submitAndDraft(
    prompt: string,
    choice: Choice,
    attachments: ImageAttachment[] = []
  ): Promise<boolean> {
    const projectId = this.openThread?.projectId ?? this.draft?.projectId;
    const threadId = this.openThread?.id;
    if (!(await this.submit(prompt, choice, attachments))) return false;
    if (projectId !== undefined && (threadId === undefined || this.openThread?.id === threadId)) {
      this.startDraft(projectId);
      this.draftChoice = { ...choice };
    }
    return true;
  }

  async send(
    prompt: string,
    threadId = this.openThread?.id,
    attachments: ImageAttachment[] = []
  ): Promise<boolean> {
    const client = this.#client;
    if (!client || !threadId || this.connection !== 'ready') return false;
    if (prompt.trim().length === 0 && attachments.length === 0) return false;
    try {
      // Reconnect snapshots must land before a new stream starts mutating the thread.
      await this.#reloading;
      if (this.#client !== client || this.connection !== 'ready') return false;
      const activity = activityCommand(prompt);
      if (activity) {
        if (attachments.length) throw new Error(strings.activity.noAttachments);
        const accepted = await client.call('threads.activity.set', { threadId, ...activity }).catch((error: unknown) => {
          if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) {
            throw new Error(strings.errors.activityUnsupported.replace('{machine}', this.core?.hostname ?? strings.app.name));
          }
          throw error;
        });
        if (this.openThread?.id === threadId) this.openThread.activity = accepted;
        return true;
      }
      const thread = this.openThread?.id === threadId ? this.openThread : this.threads.find(thread => thread.id === threadId);
      if (thread) {
        const current: Choice = { providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
          effort: thread.effort, permissionMode: thread.permissionMode, speed: thread.speed ?? null };
        const target = this.composerChoice(current);
        if (target.model !== current.model) {
          const revision = thread.selectionVersion ?? 0;
          const prepared = await this.prepareDraftChoice(target);
          if (!prepared || client !== this.#client) return false;
          if (!(await this.update(threadId, { model: prepared.model, effort: prepared.effort, speed: prepared.speed ?? null,
            expectedSelectionVersion: revision }))) return false;
        }
      }
      // The key is left out when there is nothing to carry: a turn with no
      // image sends the params it always sent.
      let pending = this.#pendingSends.get(threadId);
      const selectionVersion = (this.openThread?.id === threadId ? this.openThread : this.threads.find((thread) => thread.id === threadId))?.selectionVersion ?? 0;
      if (!pending || pending.selectionVersion !== selectionVersion || pending.prompt !== prompt || pending.attachments.length !== attachments.length || pending.attachments.some((a, i) => a.data !== attachments[i]?.data || a.mimeType !== attachments[i]?.mimeType || a.name !== attachments[i]?.name)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        pending = { id: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), prompt, attachments: [...attachments], selectionVersion };
        this.#pendingSends.set(threadId, pending);
      }
      await client.call('turns.start', {
        threadId,
        prompt,
        clientRequestId: pending.id,
        expectedSelectionVersion: selectionVersion,
        ...(attachments.length > 0 ? { attachments } : {})
      });
      this.#pendingSends.delete(threadId);
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
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
   * The two records exist for the cards of the thread on the screen, so they
   * hold that thread and nothing else. Called when a thread opens, when the
   * chat goes to a draft, and when a thread is archived or removed: before
   * this, a page left open all day kept every request it had ever been told
   * about.
   */
  #keepRequestsOf(threadId: ThreadId | null): void {
    const mine = (id: ThreadId): boolean => id === threadId;
    this.permissionRequests = requestsOf(this.permissionRequests, mine);
    this.questionRequests = requestsOf(this.questionRequests, mine);
  }

  /** The same, for a thread that is gone while another one stays open. */
  #dropRequestsOf(threadId: ThreadId): void {
    const others = (id: ThreadId): boolean => id !== threadId;
    this.permissionRequests = requestsOf(this.permissionRequests, others);
    this.questionRequests = requestsOf(this.questionRequests, others);
  }

  /**
   * `permission.requested` reaches a subscribed socket once and is gone. A page
   * that loads while a turn waits gets the same request from `permissions.list`,
   * so both paths land here and the same id never makes a second card.
   *
   * `scope` is what the list the caller holds speaks for. A list is the core's
   * whole answer about it, empty included, so an id the core no longer carries
   * was settled where this client could not hear it and its card must stop
   * offering the button. An event carries one request and speaks for nothing
   * else, so it comes in as `'one'` and drops nothing.
   */
  #mergePermissions(requests: PermissionRequest[], scope: RequestScope): void {
    const byId = new Map(
      this.pendingPermissions.filter((request) => outside(request, scope)).map((r) => [r.id, r] as const)
    );
    for (const request of requests) byId.set(request.id, request);
    this.pendingPermissions = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.permissionRequests = {
      ...this.permissionRequests,
      ...Object.fromEntries(requests.map((request) => [request.id, request] as const))
    };
  }

  /** The same rebuild as the permissions, for the same reasons. */
  #mergeQuestions(requests: QuestionRequest[], scope: RequestScope): void {
    const byId = new Map(
      this.pendingQuestions.filter((request) => outside(request, scope)).map((q) => [q.id, q] as const)
    );
    for (const request of requests) byId.set(request.id, request);
    this.pendingQuestions = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
    this.questionRequests = {
      ...this.questionRequests,
      ...Object.fromEntries(requests.map((request) => [request.id, request] as const))
    };
  }

  async answerQuestion(
    threadId: ThreadId,
    questionId: string,
    optionIds: string[],
    text?: string
  ): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('questions.answer', {
        threadId,
        questionId,
        optionIds,
        ...(text === undefined || text.length === 0 ? {} : { text })
      });
      this.pendingQuestions = this.pendingQuestions.filter((q) => q.id !== questionId);
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

  async update(
    threadId: ThreadId,
    patch: { title?: string; accountId?: string; model?: string | null; effort?: string | null; speed?: string | null; permissionMode?: PermissionMode; expectedSelectionVersion?: number }
  ): Promise<boolean> {
    const client = this.#client;
    if (!client) return false;
    try {
      const summary = await client.call('threads.update', { threadId, ...patch });
      this.#upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
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

  /** The agent's own title for the thread, asked again. The menu item is out while it runs. */
  async retitle(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client || this.retitling.includes(threadId)) return;
    this.retitling = [...this.retitling, threadId];
    try {
      const summary = await client.call('threads.retitle', { threadId });
      this.#upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) Object.assign(open, summary);
    } catch (error) {
      this.#fail(error);
    } finally {
      this.retitling = this.retitling.filter((id) => id !== threadId);
    }
  }

  /**
   * The import dialog for one project: opens at once, the list arrives when the
   * core has read the files. Behind the `session-import` experiment: a chord or
   * a palette row that reaches here with it off does nothing.
   */
  async openImports(projectId: ProjectId): Promise<void> {
    const client = this.#client;
    if (!client || !isExperimentEnabled('session-import')) return;
    this.imports = { projectId, sessions: [], loading: true, running: null };
    try {
      const sessions = await client.call('imports.list', { projectId });
      if (this.imports?.projectId === projectId) this.imports = { ...this.imports, sessions, loading: false };
    } catch (error) {
      this.imports = null;
      this.#fail(error);
    }
  }

  closeImports(): void {
    if (this.imports?.running === null) this.imports = null;
  }

  /** One session into a new thread, opened on arrival; the dialog closes with it. */
  async importSession(accountId: string, sessionId: string): Promise<void> {
    const client = this.#client;
    const dialog = this.imports;
    if (!client || !dialog || dialog.running !== null) return;
    this.imports = { ...dialog, running: sessionId };
    try {
      const summary = await client.call('imports.run', { projectId: dialog.projectId, accountId, sessionId });
      this.imports = null;
      this.#upsertThread(summary);
      this.showChat();
      await this.open(summary.id);
    } catch (error) {
      this.imports = { ...dialog, running: null };
      this.#fail(error);
    }
  }

  async pin(threadId: ThreadId, pinned: boolean): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const summary = await client.call('threads.pin', { threadId, pinned });
      this.#upsertThread(summary);
      const open = this.openThread;
      if (open && open.id === threadId) open.pinned = summary.pinned;
    } catch (error) {
      this.#fail(error);
    }
  }

  async archive(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('threads.archive', { threadId, archived: true });
      this.threads = this.threads.filter((t) => t.id !== threadId);
      this.#dropRequestsOf(threadId);
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
    // Owner-only, like the surface it draws.
    if (!client || !open || !this.owner) return;
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
  }): Promise<Account | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      const account = await client.call('accounts.add', input);
      if (!this.accounts.some((a) => a.id === account.id))
        this.accounts = [...this.accounts, account];
      return account;
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  /** Events received after the snapshot request win over its older rows. */
  #restoreLogins(events: RpcEvents['account.login'][], revision: number): void {
    const snapshot: Record<string, LoginState> = {};
    for (const { accountId, ...state } of events) {
      if (state.state !== 'done') snapshot[accountId] = { ...state, state: state.state };
    }
    for (const [accountId, changedAt] of this.#loginChanges) {
      if (changedAt <= revision) continue;
      const current = this.logins[accountId];
      if (current) snapshot[accountId] = current;
      else delete snapshot[accountId];
    }
    this.logins = snapshot;
  }

  async removeAccount(accountId: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('accounts.remove', { accountId });
      this.accounts = this.accounts.filter((a) => a.id !== accountId);
      delete this.logins[accountId];
    } catch (error) {
      this.#fail(error);
    }
  }

  async cancelLogin(accountId: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('accounts.loginCancel', { accountId });
      delete this.logins[accountId];
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

  async reloadProviders(): Promise<boolean> {
    const client = this.#client;
    if (!client) return false;
    try {
      const { loaded } = await client.call('providers.reload', {});
      this.providers = loaded;
      for (const account of this.accounts) await this.checkAccount(account.id);
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  /** Start the download. The rest arrives as `providers.installProgress`. */
  async installProvider(providerId: ProviderId): Promise<boolean> {
    const client = this.#client;
    if (!client) return false;
    try {
      const state = await client.call('providers.install', { providerId });
      this.installStates = { ...this.installStates, [providerId]: state };
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
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

  /** A toast for what happened where the user was not looking; the decision is `shouldNotify`. */
  #notify(kind: NotifyKind, threadId: ThreadId, detail: string | null): void {
    const go = shouldNotify({
      kind,
      threadId,
      openThreadId: this.visible ? this.openThread?.id ?? null : null,
      focused: typeof document !== 'undefined' && document.hasFocus() && document.visibilityState === 'visible',
      enabled: readNotifications()
    });
    if (!go) return;
    const title = this.threads.find((t) => t.id === threadId)?.title ?? strings.app.name;
    void sendNotification({
      ...toastFor(kind, this.threadKey(threadId), title, detail),
      coreThreadId: threadId,
      origin: this.endpointUrl ? new URL(this.endpointUrl).origin : undefined
    });
  }

  /** The switch of the Background card; the platform prompt comes with the first turn-on. */
  async setNotifications(enabled: boolean): Promise<void> {
    this.notifications = enabled;
    writeNotifications(enabled);
    if (!enabled) return;
    const granted = await requestNotificationPermission();
    if (!granted) this.error = strings.settings.notificationsDenied;
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
    this.#probeEpoch++;
    for (const key of this.#probeAttempts) if (key.endsWith(`::${accountId}`)) this.#probeAttempts.delete(key);
    const suffix = `::${accountId}`;
    const kept = Object.entries(this.probedModels).filter(([key]) => !key.endsWith(suffix));
    if (kept.length !== Object.keys(this.probedModels).length) {
      this.probedModels = Object.fromEntries(kept);
      this.#saveModels();
    }
  }

  #fail(error: unknown): void {
    if (error instanceof RpcFailure) this.error = `${error.message} (${error.code})`;
    else if (error instanceof Error) this.error = error.message;
    else this.error = String(error);
  }
}

export const store = new Store();
