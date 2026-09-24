import { RpcErrorCode, PREVIEW_REFERENCES_PER_TURN, previewReferencesError, type PreviewReference } from '@boite/contracts';
import { showPreviewReference } from './preview-navigation';
import { editPreviewMentions, insertPreviewMention } from './preview-mentions';
import { resetPullRequestSupport } from './pull-request';
import { activityCommand } from './activity-command';
import type {
  Account,
  AgentTask,
  AgentContact,
  CoordinationConfig,
  CoordinationPeer,
  CoordinationView,
  DelegatedAgent,
  DelegationConfig,
  DelegationView,
  CoreInfo,
  FileContent,
  FileEntry,
  GitDiff,
  GitStatus,
  Attachment,
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
  HarnessUpdate,
  ProviderInstallState,
  ProviderRejected,
  ProviderSummary,
  RequestId,
  RpcEventName,
  RpcEvents,
  RpcParams,
  RpcResult,
  SchedulerState,
  Settings,
  TelemetryState,
  TerminalState,
  Thread,
  ThreadId,
  ThreadResources,
  ThreadSummary,
  Todo
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

export type Page = 'chat' | 'settings' | 'agents';
export type SettingsTab = 'brain' | 'voice' | 'general' | 'machines' | 'appearance' | 'keyboard' | 'accounts' | 'plugins' | 'usage' | 'limits' | 'resources' | 'experiments';

/** A login process the core runs for one account, as `account.login` reports it. */
export interface LoginState {
  state: 'running' | 'failed';
  /** The last line the provider CLI printed. */
  output: string;
  /** The first https link it printed, once there is one. */
  url: string | null;
  exitCode: number | null;
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

/**
 * What one `files.*` call answers with: the value, or the sentence the surface
 * that asked prints instead. A refused path belongs to that surface, not to the
 * app's toast, so these calls hand the message back rather than raising it.
 */
export type FileAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

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

/**
 * The message a held thread asks `threads.get` to start from: the oldest one of
 * a turn this client has not seen finish, since its parts may still have moved,
 * or the last one when every turn it knows is over. Null when nothing is held.
 */
export function resumeAnchor(thread: Pick<Thread, 'messages' | 'turns'>): MessageId | null {
  const finished = new Set(thread.turns.filter((turn) => turn.finishedAt !== null).map((turn) => turn.id));
  const open = thread.messages.find((message) => message.state === 'streaming' || !finished.has(message.turnId));
  return (open ?? thread.messages[thread.messages.length - 1])?.id ?? null;
}

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
  #pendingSends = new Map<string, { id: string; prompt: string; attachments: Attachment[]; previewReferences: PreviewReference[]; selectionVersion: number }>();
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
  /** A settings card requested before its lazy page exists, with a fresh key for repeated asks. */
  settingsSection = $state<{ id: string; request: number } | null>(null);
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
  /** Where each agent of this machine stands against its newest release, the core's own reading. */
  harnessUpdates = $state<HarnessUpdate[]>([]);
  /**
   * What an agent answered `providers.probe` with, keyed `providerId::accountId`.
   * An ACP agent owns its model list; the descriptor only carries `default`.
   * One entry per provider and account the picker has opened this session, which
   * is what bounds it: the pairs exist on the machine, they do not arrive with
   * time, and an account that changes drops its own key.
   */
  probedModels = $state<Record<string, ModelInfo[]>>({});
  #probeAttempts = new Set<string>();
  /** One per-model effort read per provider, account and model, see `probeModelEffort`. */
  #effortAttempts = new Set<string>();
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
  /** Threads whose terminal drawer shows. The shell lives in the core and outlasts a hidden drawer. */
  terminalThreads = $state<ThreadId[]>([]);
  /** Accounts whose sign-in terminal is open on the Providers page. */
  loginTerminals = $state<string[]>([]);
  scheduler = $state<SchedulerState | null>(null);
  settings = $state<Settings | null>(null);
  /** The keybindings file as the core last read it; null until the first `keybindings.get`. */
  keybindings = $state<Keybindings | null>(null);
  /** Every command with its chord: the defaults, the file's entries over them. */
  bindings = $derived(resolveBindings(this.keybindings?.bindings ?? {}));
  resources = $state<ThreadResources[]>([]);
  trace = $state<ProcessRecord[]>([]);
  /**
   * The todo cards of each project, keyed by project id: the list is the
   * project's, so every thread of it shows the same one.
   */
  todos = $state<Record<ProjectId, Todo[]>>({});
  pendingPermissions = $state<PermissionRequest[]>([]);
  /**
   * Kept after the answer so a resolved card still shows what was asked. Only
   * the open thread has cards on the screen, so only its entries are held: this
   * record grew for the life of the page before that.
   */
  permissionRequests = $state<Record<RequestId, PermissionRequest>>({});
  pendingQuestions = $state<QuestionRequest[]>([]);
  /** Native agent-to-agent traffic for the open thread. It is separate from chat messages. */
  coordination = $state<CoordinationView | null>(null);
  coordinationDirectory = $state<{ agents: AgentContact[]; unavailable: string[] } | null>(null);
  coordinationLoading = $state(false);
  coordinationSaving = $state(false);
  #coordinationEpoch = 0;
  coordinationError = $state<string | null>(null);
  /** The bounded child team of the open root or child thread. */
  delegation = $state<DelegationView | null>(null);
  delegationThread = $state<Thread | null>(null);
  delegationSelectedAgentId = $state<ThreadId | null>(null);
  delegationLoading = $state(false);
  delegationSaving = $state(false);
  delegationError = $state<string | null>(null);
  #delegationEpoch = 0;
  #delegationSelectionEpoch = 0;
  #delegationConfigureEpoch = 0;
  /** Kept after the answer so a folded card still shows what was asked. Same bound. */
  questionRequests = $state<Record<RequestId, QuestionRequest>>({});
  collapsedProjects = $state<string[]>([]);

  #client: Client | null = null;
  #off: (() => void)[] = [];
  #subscribedThreadId: ThreadId | null = null;
  /** The one child transcript shown in Agents, beside the normal open-thread subscription. */
  #delegationSubscribedThreadId: ThreadId | null = null;
  /** The number of the newest `open()`, so an older one writes nothing. */
  #openGeneration = 0;
  /** What that newest run is opening, so an older one knows what to give back. */
  #openTarget: ThreadId | null = null;
  /** The thread `trace` belongs to, and whether the trace surface is on screen to read it. */
  #tracedThreadId: ThreadId | null = null;
  traceWatched = false;
  /** The load in flight and the client it speaks to, so the two callers of `reload()` share one. */
  #reloading: { client: Client; promise: Promise<void> } | null = null;
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
    return this.threads.filter((t) => t.projectId === projectId && !t.archived && !t.parentThreadId);
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

  /**
   * OpenCode names a model's reasoning efforts only once a session is on that
   * model, so the list a probe reads carries none. The composer asks for the
   * model it landed on, once per model, and the effort chip fills in.
   */
  async probeModelEffort(providerId: ProviderId, accountId: string, model: string): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    const key = `${probeKey(providerId, accountId)}::${model}`;
    if (this.#effortAttempts.has(key)) return;
    await this.probeModels(providerId, accountId);
    const listed = this.modelsOf(providerId, accountId).find(entry => entry.id === model);
    if (!listed || listed.effort !== undefined || this.#effortAttempts.has(key)) return;
    this.#effortAttempts.add(key);
    const epoch = this.#probeEpoch;
    try {
      const { models } = await client.call('providers.probe', { providerId, accountId, model });
      if (client !== this.#client || epoch !== this.#probeEpoch) return;
      this.probedModels = { ...this.probedModels, [probeKey(providerId, accountId)]: models };
      this.#saveModels();
    } catch (error) {
      // An older core refuses nothing here, it just answers the plain list; a
      // real failure is the agent's, and the chip simply stays absent.
      if (client === this.#client) this.#effortAttempts.delete(key);
      console.warn('reading the model efforts failed', error);
    }
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
      } catch (error) {
        if (client !== this.#client) return;
        // The account or the descriptors changed while the agent answered: the
        // core refused a stale list, and the next look asks again.
        if (epoch !== this.#probeEpoch) this.#probeAttempts.delete(key);
        else this.#fail(error);
      }
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
    this.terminalThreads = [];
    this.loginTerminals = [];
    this.#client = client;
    this.probedModels = {};
    this.#probeEpoch++;
    this.#probeAttempts.clear();
    this.#effortAttempts.clear();
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
    this.#effortAttempts.clear();
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
      if (this.delegationThread?.id === summary.id) Object.assign(this.delegationThread, summary);
    });
    // The agent's `/name` list is the whole list each time, and it lives on the
    // open thread only: a summary in the sidebar carries none.
    on('thread.commands', ({ threadId, commands }) => {
      const open = this.openThread;
      if (open && open.id === threadId) open.commands = commands;
    });
    // What the agent still runs in the background, whole each time, like the commands.
    on('thread.background', ({ threadId, tasks }) => {
      const open = this.openThread;
      if (open && open.id === threadId) open.background = tasks;
    });
    on('thread.activity', ({ threadId, activity }) => {
      if (this.openThread?.id === threadId) this.openThread.activity = activity;
    });
    on('collaboration.changed', ({ threadId }) => {
      if (this.openThread?.id === threadId) void this.loadCoordination(threadId, false);
    });
    on('delegation.changed', ({ threadId }) => {
      const open = this.openThread;
      const view = this.delegation;
      if (open && (threadId === open.id || threadId === open.parentThreadId || threadId === view?.rootThreadId)) {
        void this.loadDelegation(open.id);
      }
    });
    // The agent of a thread asked its panel for something. The layout is per
    // thread, so it is written on that thread's panel even while another one is
    // on screen: opening the thread later shows what was asked for.
    on('panel.requested', ({ threadId, surface }) => {
      rightPanel.for(this.threadKey(threadId)).showSurface(surface);
    });
    // The project's whole list after any change, whoever moved a card.
    on('todos.updated', ({ projectId, todos }) => {
      this.todos = { ...this.todos, [projectId]: todos };
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
      // A stop is the user's own doing: nothing to tell them.
      if (turn.status === 'done') this.#notify('done', turn.threadId, null);
      else if (turn.status === 'error') this.#notify('error', turn.threadId, turn.error);
    });

    on('message.started', (message) => {
      for (const target of this.#threadSnapshots(message.threadId)) {
        const index = target.messages.findIndex((m) => m.id === message.id);
        if (index >= 0) target.messages[index] = message;
        else target.messages.push(message);
      }
    });

    on('message.delta', ({ threadId, messageId, partIndex, text }) => {
      for (const message of this.#messages(threadId, messageId)) {
        const part = message.parts[partIndex];
        // A delta appends to whatever kind of text part sits there: text or thinking.
        if (part && (part.type === 'text' || part.type === 'thinking')) part.text += text;
        // On a tool part it is the input's JSON, still being typed by the model.
        else if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + text;
        else if (!part) message.parts[partIndex] = { type: 'text', text };
      }
    });

    on('message.part', ({ threadId, messageId, partIndex, part }) => {
      for (const message of this.#messages(threadId, messageId)) message.parts[partIndex] = part;
    });

    on('message.completed', ({ threadId, messageId, state }) => {
      for (const message of this.#messages(threadId, messageId)) message.state = state;
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
    on('providers.updatesChanged', (updates) => {
      this.harnessUpdates = updates;
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
    this.#effortAttempts.clear();
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
    this.#coordinationEpoch++;
    this.coordination = null;
    this.coordinationDirectory = null;
    this.coordinationLoading = false;
    this.coordinationSaving = false;
    this.coordinationError = null;
    this.#delegationEpoch++;
    this.#delegationSelectionEpoch++;
    this.#delegationConfigureEpoch++;
    this.delegation = null;
    this.delegationThread = null;
    this.delegationSelectedAgentId = null;
    this.delegationLoading = false;
    this.delegationSaving = false;
    this.delegationError = null;
    for (const off of this.#off) off();
    this.#off = [];
    this.#client = null;
    this.#subscribedThreadId = null;
    this.#delegationSubscribedThreadId = null;
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
            delegationDemo: params.get('team') === '1',
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
      const opens = this.#openGeneration;
      await this.connect();
      // `&open=recent` lands on the most recent thread instead of a draft, the
      // page most captures are about. Fake core only, like `&long=1`.
      if (import.meta.env.DEV && params.get('fake') === '1' && params.get('open') === 'recent') await this.openWhereLeft();
      // A thread clicked while the lists arrived is still opening: it wins.
      else if (this.#openGeneration === opens) await this.openLanding();
      // `&panel=<kind>` opens that surface on the thread the page lands on, so
      // a capture of it needs no clicks. Fake core only, like `&long=1`.
      if (import.meta.env.DEV && params.get('fake') === '1') this.#openQueryPanel(params.get('panel'));
    } finally {
      this.booted = true;
    }
  }

  #openQueryPanel(kind: string | null): void {
    if (kind === null || !this.openThread) return;
    const panel = this.panel;
    // `file:<path>` and `files:<path>` carry what the surface opens on, which
    // is how a capture reaches one file with no click.
    const cut = kind.indexOf(':');
    const name = cut < 0 ? kind : kind.slice(0, cut);
    const path = cut < 0 ? '' : kind.slice(cut + 1);
    if (name === 'changes') panel.openChanges(path === '' ? undefined : path);
    else if (name === 'files') panel.openFiles(path === '' ? undefined : path);
    else if (name === 'file' && path !== '') panel.openFile(path);
    else if (name === 'tasks') panel.openTasks();
    else if (name === 'agents') panel.open('agents');
    else if (name === 'trace') panel.open('trace');
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
    this.composerStates = {};
    this.#previewUndo.clear();
    this.#composerInsertions.clear();
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

  /** Per core, so two machines each land on their own project. */
  #lastProjectKey(): string { return 'boite.lastProject.v1:' + JSON.stringify([this.endpointUrl, this.core?.dataDir]); }
  #rememberProject(projectId: ProjectId): void {
    try { localStorage.setItem(this.#lastProjectKey(), projectId); } catch { /* storage unavailable: the recent thread decides */ }
  }

  /** The project last opened or drafted in on this device, else the one of the most recent thread, else the first. */
  lastProject(): ProjectId | null {
    let stored: string | null = null;
    try { stored = localStorage.getItem(this.#lastProjectKey()); } catch { /* storage unavailable */ }
    const known = this.projects.find((p) => p.id === stored);
    if (known) return known.id;
    const recent = this.threads.filter((t) => !t.archived && !t.parentThreadId).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return recent?.projectId ?? this.projects[0]?.id ?? null;
  }

  /** Where the app opens: a new thread's draft in the last used project, as if New thread had been pressed. */
  async openLanding(): Promise<void> {
    if (!this.visible) return;
    // Settings opened while the core was still answering stays open.
    if (this.openThread || this.draft || this.page !== 'chat') return;
    const project = this.lastProject();
    if (project) this.startDraft(project);
  }

  /** The most recent thread, a draft in the first project, or nothing on a first run. */
  async openWhereLeft(): Promise<void> {
    if (!this.visible) return;
    if (this.openThread || this.draft) return;
    const live = this.threads.filter((t) => !t.archived && !t.parentThreadId);
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

  async loadCoordination(threadId = this.openThread?.id, withDirectory = true): Promise<void> {
    const client = this.#client;
    if (!client || !threadId) return;
    const epoch = ++this.#coordinationEpoch;
    const current = () => this.#client === client && this.openThread?.id === threadId && this.#coordinationEpoch === epoch;
    if (this.coordination?.self.threadId !== threadId) { this.coordination = null; this.coordinationDirectory = null; }
    this.coordinationLoading = true;
    this.coordinationError = null;
    try {
      const view = await client.call('collaboration.get', { threadId });
      if (!current()) return;
      this.coordination = view;
      if (withDirectory) {
        const directory = await client.call('collaboration.directory', { threadId });
        if (current()) this.coordinationDirectory = directory;
      }
    } catch (error) {
      if (current()) this.coordinationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) this.coordinationLoading = false;
    }
  }

  async configureCoordination(config: CoordinationConfig): Promise<void> {
    const client = this.#client;
    const threadId = this.openThread?.id;
    if (!client || !threadId || !this.owner || this.coordinationSaving) return;
    this.coordinationSaving = true;
    this.coordinationError = null;
    try {
      await client.call('collaboration.configure', { threadId, config });
      if (this.#client === client && this.openThread?.id === threadId) await this.loadCoordination(threadId);
    } catch (error) {
      if (this.#client === client && this.openThread?.id === threadId) this.coordinationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (this.#client === client) this.coordinationSaving = false;
    }
  }

  async loadDelegation(threadId = this.openThread?.id): Promise<void> {
    const client = this.#client;
    if (!client || !threadId) return;
    const epoch = ++this.#delegationEpoch;
    const current = () => this.#client === client && this.openThread?.id === threadId && this.#delegationEpoch === epoch;
    this.delegationLoading = true;
    this.delegationError = null;
    try {
      const view = await client.call('delegation.get', { threadId });
      if (!current()) return;
      this.delegation = view;
      const selected = this.delegationSelectedAgentId;
      if (selected && !view.agents.some(agent => agent.thread.id === selected)) {
        await this.selectDelegatedAgent(null);
      } else if (selected && this.delegationThread?.id === selected) {
        const summary = view.agents.find(agent => agent.thread.id === selected)?.thread;
        if (summary) Object.assign(this.delegationThread, summary);
      }
    } catch (error) {
      if (current()) this.delegationError = this.#reason(error);
    } finally {
      if (current()) this.delegationLoading = false;
    }
  }

  #delegationRootId(): ThreadId | null {
    const thread = this.openThread;
    if (!thread) return null;
    const root = thread.parentThreadId ?? thread.id;
    if (this.delegation) return this.delegation.rootThreadId === root ? root : null;
    return thread.parentThreadId ? null : root;
  }

  async configureDelegation(config: DelegationConfig): Promise<void> {
    const client = this.#client;
    const openThreadId = this.openThread?.id;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !this.owner || this.delegationSaving) return;
    const epoch = ++this.#delegationConfigureEpoch;
    this.delegationSaving = true;
    this.delegationError = null;
    try {
      const view = await client.call('delegation.configure', { threadId, config });
      if (client === this.#client && this.openThread?.id === openThreadId && epoch === this.#delegationConfigureEpoch) {
        if (openThreadId === threadId) this.delegation = view;
        else await this.loadDelegation(openThreadId);
      }
    } catch (error) {
      if (client === this.#client && this.openThread?.id === openThreadId && epoch === this.#delegationConfigureEpoch) this.delegationError = this.#reason(error);
    } finally {
      if (client === this.#client && epoch === this.#delegationConfigureEpoch) this.delegationSaving = false;
    }
  }

  /** One child transcript in the panel, while the parent conversation keeps streaming. */
  async selectDelegatedAgent(threadId: ThreadId | null): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const epoch = ++this.#delegationSelectionEpoch;
    const previous = this.#delegationSubscribedThreadId;
    this.delegationSelectedAgentId = threadId;
    this.delegationThread = null;
    this.#delegationSubscribedThreadId = null;
    if (previous && previous !== this.#subscribedThreadId && previous !== threadId) {
      await client.call('threads.unsubscribe', { threadId: previous }).catch(() => undefined);
    }
    if (threadId === null) return;
    try {
      if (threadId !== this.#subscribedThreadId) {
        await client.call('threads.subscribe', { threadId });
        if (epoch !== this.#delegationSelectionEpoch || client !== this.#client) {
          if (this.delegationSelectedAgentId !== threadId && this.#subscribedThreadId !== threadId) {
            await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
          }
          return;
        }
      }
      if (epoch === this.#delegationSelectionEpoch && client === this.#client) this.#delegationSubscribedThreadId = threadId;
      const thread = await client.call('threads.get', { threadId });
      if (epoch === this.#delegationSelectionEpoch && client === this.#client && this.delegationSelectedAgentId === threadId) {
        this.delegationThread = thread;
      }
    } catch (error) {
      if (epoch === this.#delegationSelectionEpoch && client === this.#client) this.delegationError = this.#reason(error);
    }
  }

  async spawnDelegatedAgent(profileId: string, task: string, title?: string): Promise<DelegatedAgent | null> {
    const client = this.#client;
    const openThreadId = this.openThread?.id;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !this.owner || !task.trim()) return null;
    this.delegationError = null;
    try {
      const agent = await client.call('delegation.spawn', {
        threadId,
        profileId,
        task: task.trim(),
        ...(title?.trim() ? { title: title.trim() } : {}),
        requestId: crypto.randomUUID()
      });
      if (client !== this.#client || this.openThread?.id !== openThreadId) return null;
      await this.loadDelegation(openThreadId);
      return agent;
    } catch (error) {
      if (client === this.#client && this.openThread?.id === openThreadId) this.delegationError = this.#reason(error);
      return null;
    }
  }

  async messageDelegatedAgent(toThreadId: ThreadId, text: string): Promise<boolean> {
    const client = this.#client;
    const threadId = this.#delegationRootId();
    if (!client || !threadId || !text.trim()) return false;
    this.delegationError = null;
    try {
      await client.call('delegation.send', { threadId, toThreadId, text: text.trim(), requestId: crypto.randomUUID() });
      if (client !== this.#client || this.delegation?.rootThreadId !== threadId) return false;
      await this.loadDelegation(this.openThread?.id);
      return true;
    } catch (error) {
      if (client === this.#client && this.delegation?.rootThreadId === threadId) this.delegationError = this.#reason(error);
      return false;
    }
  }

  async stopDelegatedAgent(agentId?: ThreadId): Promise<void> {
    const client = this.#client;
    const threadId = this.#delegationRootId();
    if (!client || !threadId) return;
    this.delegationError = null;
    try {
      await client.call('delegation.stop', { threadId, ...(agentId ? { agentId } : {}) });
      if (client === this.#client && this.delegation?.rootThreadId === threadId) await this.loadDelegation(this.openThread?.id);
    } catch (error) {
      if (client === this.#client && this.delegation?.rootThreadId === threadId) this.delegationError = this.#reason(error);
    }
  }

  async coordinationIdentity(): Promise<CoordinationPeer> {
    if (!this.#client) throw new Error(strings.connection.unavailable);
    return this.#client.call('collaboration.identity', {});
  }

  async coordinationPeers(): Promise<CoordinationPeer[]> {
    if (!this.#client) throw new Error(strings.connection.unavailable);
    return this.#client.call('collaboration.peers', {});
  }

  async checkCoordinationPeer(coreId: string): Promise<void> {
    if (!this.#client) throw new Error(strings.connection.unavailable);
    await this.#client.call('collaboration.check', { coreId });
  }

  async trustCoordinationPeer(peer: CoordinationPeer): Promise<CoordinationPeer> {
    if (!this.#client) throw new Error(strings.connection.unavailable);
    return this.#client.call('collaboration.trust', { peer });
  }

  async untrustCoordinationPeer(coreId: string): Promise<void> {
    if (!this.#client) throw new Error(strings.connection.unavailable);
    await this.#client.call('collaboration.untrust', { coreId });
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
    const client = this.#client;
    if (!client) return this.#load();
    // The load in flight belongs to the client that started it. A machine
    // switched under a slow boot used to hand the new client that same
    // promise, whose result `#load()` then discards for being the old one's,
    // so the new machine's store stayed empty until something asked again.
    if (this.#reloading?.client === client) return this.#reloading.promise;
    const promise = this.#load().finally(() => {
      if (this.#reloading?.promise === promise) this.#reloading = null;
    });
    this.#reloading = { client, promise };
    return promise;
  }

  async #load(): Promise<void> {
    const client = this.#client;
    if (!client) return;
    const loginRevision = this.#loginRevision;
    // One rejected call used to take the whole boot down: `Promise.all` jumped
    // to the catch, which only toasted, and projects, threads, providers and
    // accounts silently kept their pre-reconnect values under an app that
    // looked loaded. Each slice lands on its own now, and only what failed is
    // reported.
    const results = await Promise.allSettled([
      client.call('projects.list', {}),
      client.call('threads.list', {}),
      client.call('providers.list', {}),
      client.call('accounts.list', {}),
      client.call('settings.get', {}),
      client.call('scheduler.get', {}),
      client.call('permissions.list', {}),
      client.call('questions.list', {}),
      // The one owner-only call of the boot. A device asking for it is refused.
      this.owner ? client.call('accounts.logins', {}) : Promise.resolve([]),
      client.call('keybindings.get', {})
    ]);
    // A machine switched under a slow boot must not have this one's data
    // written into it: the store may already be serving another client.
    if (client !== this.#client) return;
    const [projects, threads, providers, accounts, settings, scheduler, permissions, questions, logins, keybindings] = results;
    if (permissions.status === 'fulfilled') this.#mergePermissions(permissions.value, 'all');
    if (questions.status === 'fulfilled') this.#mergeQuestions(questions.value, 'all');
    if (projects.status === 'fulfilled') this.projects = projects.value;
    if (threads.status === 'fulfilled') this.threads = threads.value;
    if (providers.status === 'fulfilled') {
      this.providers = providers.value.loaded;
      this.rejectedProviders = providers.value.rejected;
      this.installStates = installStatesOf(providers.value.loaded);
    }
    if (accounts.status === 'fulfilled') {
      this.accounts = accounts.value;
      this.#restoreModels();
    }
    if (logins.status === 'fulfilled') this.#restoreLogins(logins.value, loginRevision);
    if (settings.status === 'fulfilled') this.settings = settings.value;
    if (keybindings.status === 'fulfilled') this.keybindings = keybindings.value;
    if (scheduler.status === 'fulfilled') this.scheduler = scheduler.value;
    const failed = results.find((result) => result.status === 'rejected');
    if (failed !== undefined && failed.status === 'rejected') this.#fail(failed.reason);
    // What `bench/startup.ts` reads: the first moment the app holds its data.
    if (typeof performance !== 'undefined' && performance.getEntriesByName('boite:ready').length === 0) performance.mark('boite:ready');
    void this.loadHarnessUpdates();
    const open = this.openThread;
    if (open && this.visible) {
      try {
        await this.open(open.id, false);
      } catch (error) {
        this.#fail(error);
      }
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

  /**
   * A chord for one command, null for none, or `default` to take the command
   * out of the file. The refusal comes back for the row that asked, not as
   * the app's error.
   */
  async setKeybinding(id: KeybindingCommand, chord: string | null | 'default'): Promise<string | null> {
    const client = this.#client;
    if (!client) return strings.connection.unavailable;
    try {
      this.keybindings = chord === 'default'
        ? await client.call('keybindings.reset', { command: id })
        : await client.call('keybindings.set', { command: id, chord });
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Every command back on its default. */
  async resetKeybindings(): Promise<string | null> {
    const client = this.#client;
    if (!client) return strings.connection.unavailable;
    try {
      this.keybindings = await client.call('keybindings.reset', {});
      return null;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** ` (Ctrl+N)` for a tooltip, or nothing while the command has no key. */
  keyHint(id: KeybindingCommand): string {
    const label = this.keyLabel(id);
    return label === null ? '' : ` (${label})`;
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  showSettings(tab: SettingsTab = 'general', section: string | null = null): void {
    this.settingsTab = tab;
    this.settingsSection = section === null
      ? null
      : { id: section, request: (this.settingsSection?.request ?? 0) + 1 };
    this.page = 'settings';
    if (tab === 'resources') void this.refreshResources();
  }

  showChat(): void {
    this.page = 'chat';
  }

  showAgents(): void {
    this.page = 'agents';
    this.sidebarOpen = false;
  }

  /** The right panel of the thread that is open, surfaces and all. */
  get panel(): BoundPanel {
    return rightPanel.for(this.openThread ? this.threadKey(this.openThread.id) : null);
  }

  /** Whether that panel is showing. The chat header's button reads it. */
  get panelOpen(): boolean {
    return this.panel.isOpen;
  }

  /**
   * The header's Panel button: the panel itself, open or shut. An empty panel
   * opens on its launcher rather than forcing one surface on the user.
   */
  togglePanel(): void {
    this.panel.toggle();
  }

  // -------------------------------------------------------------------------
  // Terminals
  // -------------------------------------------------------------------------

  terminalShown(threadId: ThreadId): boolean {
    return this.terminalThreads.includes(threadId);
  }

  /** Ctrl+J: the open thread's drawer, shown or hidden. A shell is the owner's to run. */
  toggleTerminal(): void {
    const open = this.openThread;
    if (!open || !this.owner) return;
    if (this.terminalShown(open.id)) this.hideTerminal(open.id);
    else this.terminalThreads = [...this.terminalThreads, open.id];
  }

  hideTerminal(threadId: ThreadId): void {
    this.terminalThreads = this.terminalThreads.filter((id) => id !== threadId);
  }

  /** The thread's shell, attached or started; null when the core refused, with the reason in the toast. */
  async openTerminal(threadId: ThreadId, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      return await client.call('terminals.open', { threadId, cols, rows });
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  /** The account's sign-in shell with its login command typed in, attached or started. */
  async loginTerminal(accountId: string, cols: number, rows: number): Promise<TerminalState | null> {
    const client = this.#client;
    if (!client) return null;
    try {
      return await client.call('accounts.loginTerminal', { accountId, cols, rows });
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  showLoginTerminal(accountId: string): void {
    if (!this.loginTerminals.includes(accountId)) this.loginTerminals = [...this.loginTerminals, accountId];
  }

  hideLoginTerminal(accountId: string): void {
    this.loginTerminals = this.loginTerminals.filter((id) => id !== accountId);
  }

  /** Keystrokes. A shell that ended in between has nothing to take them, which is not an error to show. */
  writeTerminal(id: string, data: string): void {
    void this.#client?.call('terminals.write', { id, data }).catch(() => undefined);
  }

  resizeTerminal(id: string, cols: number, rows: number): void {
    void this.#client?.call('terminals.resize', { id, cols, rows }).catch(() => undefined);
  }

  /** Kills the shell; `terminal.exited` follows. */
  async closeTerminal(id: string): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      await client.call('terminals.close', { id });
    } catch (error) {
      this.#fail(error);
    }
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
    this.#tracedThreadId = null;
    this.#keepRequestsOf(null);
    this.draft = { projectId: target, worktree: false };
    this.#rememberProject(target);
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
    this.#rememberProject(projectId);
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
    if (this.openThread?.id !== threadId && this.delegationSelectedAgentId && this.delegationSelectedAgentId !== threadId) {
      await this.selectDelegatedAgent(null);
      if (!newest()) return;
    }
    try {
      const previous = this.#subscribedThreadId;
      // Everything this open needs leaves in one burst, in the order the core
      // must run it: on a 150 ms link, five calls awaited one after the other
      // were three quarters of a second before the last card was right, and the
      // messages waited behind a subscribe and an unsubscribe they do not need.
      const subscribed = client.call('threads.subscribe', { threadId });
      // A thread already in hand, open or among the recent ones, asks only for
      // what it cannot vouch for: a reconnect on a long conversation used to
      // download its last 120 messages again for the two that were new.
      const held = this.openThread?.id === threadId ? this.openThread : this.#readingThreads.get(threadId);
      const after = held ? resumeAnchor(held) : null;
      const fetched = client.call('threads.get', after === null ? { threadId } : { threadId, after });
      const permissionsAsked = client.call('permissions.list', { threadId });
      const questionsAsked = client.call('questions.list', { threadId });
      // A run that a newer click overtakes returns early and never awaits these.
      for (const asked of [fetched, permissionsAsked, questionsAsked]) asked.catch(() => undefined);
      await subscribed;
      if (!newest()) {
        // A newer click took over while this one was in flight. Its own thread
        // is the one the socket keeps, so this subscription goes back.
        if (this.#openTarget !== threadId) {
          await client.call('threads.unsubscribe', { threadId }).catch(() => undefined);
        }
        return;
      }
      this.#subscribedThreadId = threadId;
      // A thread already left that the core will not let go of costs a few
      // events, not the open of this one.
      const unsubscribed: Promise<unknown> = previous && previous !== threadId && previous !== this.#delegationSubscribedThreadId
        ? client.call('threads.unsubscribe', { threadId: previous }).catch(() => undefined)
        : Promise.resolve();
      const thread = await fetched;
      if (!newest()) return;
      this.rememberReadingThread();
      const cached = this.#readingThreads.get(threadId);
      const freshIds = new Set(thread.messages.map(m => m.id));
      if (thread.messagesFrom !== undefined && held) {
        const from = held.messages.findIndex((m) => m.id === thread.messagesFrom);
        thread.messages = [...held.messages.slice(0, from === -1 ? held.messages.length : from).filter((m) => !freshIds.has(m.id)), ...thread.messages];
        const freshTurns = new Set(thread.turns.map((turn) => turn.id));
        thread.turns = [...held.turns.filter((turn) => !freshTurns.has(turn.id)), ...thread.turns];
        thread.messagesBefore = held.messagesBefore;
        delete thread.messagesFrom;
      } else if (cached && cached.messages.some(m => freshIds.has(m.id))) {
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
      if (this.openThread?.id !== threadId) {
        this.#delegationEpoch++;
        this.#delegationConfigureEpoch++;
        this.delegation = null;
        this.delegationLoading = false;
        this.delegationSaving = false;
        this.delegationError = null;
      }
      this.openThread = thread;
      // The thread that was open takes its permission and question cards with it.
      this.#keepRequestsOf(threadId);
      if (navigate) {
        this.page = 'chat';
        this.sidebarOpen = false;
        if (thread.projectId) this.#rememberProject(thread.projectId);
      }
      // The trace is read by its surface alone, so it is fetched only while
      // that surface is on screen, and never in the way of the messages.
      // A new thread empties it and the surface's own effect reads the new
      // one; the same thread again is a reconnect, which that effect never sees.
      if (this.#tracedThreadId !== threadId) this.trace = [];
      else if (this.traceWatched) void this.refreshTrace();
      this.#tracedThreadId = threadId;
      // The thread may already be waiting on a request this page never saw,
      // and may have had one settled where this client could not hear it.
      const permissions = await permissionsAsked;
      const questions = await questionsAsked;
      await unsubscribed;
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
      // Older turns go first, as in the journal: the last one is the latest turn.
      still.turns.unshift(...(page.turns ?? []).filter((turn) => !knownTurns.has(turn.id)));
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
    attachments: Attachment[];
    previewReferences?: PreviewReference[];
    selection?: { start: number; end: number };
    mentionInsertion?: number;
    queued: { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[] }[];
    sending: boolean;
    paused: boolean;
  }>>({});

  #previewUndo = new Map<string, { text: string; references: PreviewReference[] }[]>();
  #composerInsertions = new Map<string, (start: number, end: number, text: string) => void>();

  registerComposerInsertion(key: string, insert: (start: number, end: number, text: string) => void): () => void {
    this.#composerInsertions.set(key, insert);
    return () => { if (this.#composerInsertions.get(key) === insert) this.#composerInsertions.delete(key); };
  }

  editComposerText(key: string, value: string, undo = false, edit?: { start: number; end: number }): void {
    this.composerStates[key] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const draft = this.composerStates[key]!;
    const historyKey = this.threadKey(key);
    const previous = this.#previewUndo.get(historyKey);
    if (!previous && !draft.previewReferences?.length) { draft.text = value; return; }
    const history = previous ?? [];
    const restored = undo ? history.findLast(entry => entry.text === value) : undefined;
    history.push({ text: draft.text, references: draft.previewReferences ?? [] });
    if (history.length > 50) history.shift();
    this.#previewUndo.set(historyKey, history);
    draft.previewReferences = restored?.references ?? editPreviewMentions(draft.text, value, draft.previewReferences ?? [], edit);
    draft.text = value;
  }

  addPreviewReference(threadId: string, reference: PreviewReference): boolean {
    if (previewReferencesError([reference])) { this.error = strings.previewComments.failed; return false; }
    this.composerStates[threadId] ??= { text: '', attachments: [], queued: [], sending: false, paused: false };
    const draft = this.composerStates[threadId]!;
    const refs = draft.previewReferences ?? [];
    if (refs.some(item => item.id === reference.id)) return true;
    const inserted = insertPreviewMention(draft.text, refs, reference, draft.selection?.start, draft.selection?.end);
    if (inserted.references.length > PREVIEW_REFERENCES_PER_TURN) { this.error = strings.previewComments.tooMany; return false; }
    const historyKey = this.threadKey(threadId);
    const history = this.#previewUndo.get(historyKey) ?? [];
    history.push({ text: draft.text, references: refs });
    if (history.length > 50) history.shift();
    this.#previewUndo.set(historyKey, history);
    const start = Math.min(draft.text.length, draft.selection?.start ?? draft.text.length);
    const end = Math.min(draft.text.length, draft.selection?.end ?? draft.text.length);
    this.#composerInsertions.get(threadId)?.(start, end, inserted.text.slice(start, inserted.text.length - draft.text.length + end));
    draft.text = inserted.text;
    draft.previewReferences = inserted.references;
    draft.selection = { start: inserted.caret, end: inserted.caret };
    draft.mentionInsertion = (draft.mentionInsertion ?? 0) + 1;
    return true;
  }

  async revealPreviewReference(threadId: string, reference: PreviewReference): Promise<void> {
    try { await showPreviewReference(this, threadId, reference); }
    catch (error) { this.#fail(error); }
  }

  /** Add reviewed context to this machine's unsent draft without queuing a turn. */
  appendComposerText(threadId: string, text: string): void {
    if (!text.trim()) return;
    this.composerStates[threadId] ??= {
      text: '', attachments: [], queued: [], sending: false, paused: false
    };
    const draft = this.composerStates[threadId]!;
    draft.text = draft.text ? `${draft.text}\n\n${text}` : text;
  }

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
      ['claude-sdk', 'acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol)) {
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

  async submit(prompt: string, choice: Choice, attachments: Attachment[] = [], previewReferences: PreviewReference[] = []): Promise<boolean> {
    if ((prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) || this.connection !== 'ready') return false;
    try {
      if (activityCommand(prompt) && previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
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
      return this.send(prompt, this.openThread.id, attachments, previewReferences);
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
    return this.send(prompt, created.id, attachments, previewReferences);
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
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    const projectId = this.openThread?.projectId ?? this.draft?.projectId;
    const threadId = this.openThread?.id;
    if (!(await this.submit(prompt, choice, attachments, previewReferences))) return false;
    if (projectId !== undefined && (threadId === undefined || this.openThread?.id === threadId)) {
      this.startDraft(projectId);
      this.draftChoice = { ...choice };
    }
    return true;
  }

  async send(
    prompt: string,
    threadId = this.openThread?.id,
    attachments: Attachment[] = [],
    previewReferences: PreviewReference[] = []
  ): Promise<boolean> {
    const client = this.#client;
    if (!client || !threadId || this.connection !== 'ready') return false;
    if (prompt.trim().length === 0 && attachments.length === 0 && previewReferences.length === 0) return false;
    try {
      // Reconnect snapshots must land before a new stream starts mutating the thread.
      await this.#reloading?.promise;
      if (this.#client !== client || this.connection !== 'ready') return false;
      const activity = activityCommand(prompt);
      if (activity) {
        if (previewReferences.length) throw new Error(strings.previewComments.activityUnsupported);
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
      if (!pending || pending.selectionVersion !== selectionVersion || pending.prompt !== prompt || JSON.stringify(pending.previewReferences) !== JSON.stringify(previewReferences) || pending.attachments.length !== attachments.length || pending.attachments.some((a, i) => a.kind !== attachments[i]?.kind || a.data !== attachments[i]?.data || a.mimeType !== attachments[i]?.mimeType || a.name !== attachments[i]?.name)) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        pending = { id: Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''), prompt, attachments: [...attachments], previewReferences: JSON.parse(JSON.stringify(previewReferences)) as PreviewReference[], selectionVersion };
        this.#pendingSends.set(threadId, pending);
      }
      await client.call('turns.start', {
        threadId,
        prompt,
        clientRequestId: pending.id,
        expectedSelectionVersion: selectionVersion,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(previewReferences.length > 0 ? { previewReferences } : {})
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

  // -------------------------------------------------------------------------
  // The workbench: the working tree, its files and the project's todos. Every
  // one of these is owner-only in `packages/core/src/access.ts`, so each is
  // gated on `this.owner` the way `trace.get` is rather than thrown at a phone.
  //
  // The three `files.*` calls answer a `FileAnswer` rather than raising the
  // app's toast: a refused path or a file that vanished under the editor is
  // about the surface that asked, so it reads in that surface.
  // -------------------------------------------------------------------------

  /** The project of a thread, open or not: what keys the todo list. */
  #projectOf(threadId: ThreadId): ProjectId | null {
    if (this.openThread?.id === threadId) return this.openThread.projectId;
    return this.threads.find((thread) => thread.id === threadId)?.projectId ?? null;
  }

  async gitStatus(threadId: ThreadId): Promise<GitStatus | null> {
    const client = this.#client;
    if (!client || !this.owner) return null;
    try {
      return await client.call('git.status', { threadId });
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async gitDiff(threadId: ThreadId, path: string, ref?: string): Promise<GitDiff | null> {
    const client = this.#client;
    if (!client || !this.owner) return null;
    try {
      return await client.call('git.diff', { threadId, path, ...(ref === undefined ? {} : { ref }) });
    } catch (error) {
      this.#fail(error);
      return null;
    }
  }

  async listFiles(threadId: ThreadId, path?: string): Promise<FileAnswer<FileEntry[]>> {
    const client = this.#client;
    if (!client || !this.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.list', { threadId, ...(path === undefined ? {} : { path }) });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.#reason(error) };
    }
  }

  async readFile(threadId: ThreadId, path: string): Promise<FileAnswer<FileContent>> {
    const client = this.#client;
    if (!client || !this.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.read', { threadId, path });
      // The core answers a path on its own HTTP server: the origin is the one
      // this client reached it by, which a core cannot know from where it runs.
      if (value.kind !== 'text' && value.url.startsWith('/') && this.endpointUrl !== null) {
        return { ok: true, value: { ...value, url: new URL(value.url, this.endpointUrl).href } };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.#reason(error) };
    }
  }

  /** The editor's save. The bytes that reached the disk, or why they did not. */
  async writeFile(
    threadId: ThreadId,
    path: string,
    text: string
  ): Promise<FileAnswer<{ bytes: number; modifiedAt: number }>> {
    const client = this.#client;
    if (!client || !this.owner) return { ok: false, error: strings.rightPanel.ownerOnly };
    try {
      const value = await client.call('files.write', { threadId, path, text });
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: this.#reason(error) };
    }
  }

  /** The agent's task list, whole. The answer arrives as `thread.activity` too. */
  async setTasks(threadId: ThreadId, tasks: AgentTask[]): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    try {
      const activity = await client.call('threads.tasks.set', { threadId, tasks });
      if (this.openThread?.id === threadId) this.openThread.activity = activity;
    } catch (error) {
      this.#fail(error);
    }
  }

  async loadTodos(threadId: ThreadId): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    try {
      const todos = await client.call('todos.list', { threadId });
      // The list keys on the project, which an empty answer does not carry.
      const projectId = todos[0]?.projectId ?? this.#projectOf(threadId);
      if (projectId === null) return;
      this.todos = { ...this.todos, [projectId]: todos };
    } catch (error) {
      this.#fail(error);
    }
  }

  async addTodo(threadId: ThreadId, text: string): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner || text.trim().length === 0) return;
    try {
      await client.call('todos.add', { threadId, text: text.trim() });
    } catch (error) {
      this.#fail(error);
    }
  }

  async updateTodo(
    threadId: ThreadId,
    todoId: string,
    patch: { status?: Todo['status']; text?: string }
  ): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    try {
      await client.call('todos.update', { threadId, todoId, ...patch });
    } catch (error) {
      this.#fail(error);
    }
  }

  async removeTodo(threadId: ThreadId, todoId: string): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    try {
      await client.call('todos.remove', { threadId, todoId });
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

  telemetryState(): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.state', {});
  }

  configureTelemetry(mode: TelemetryState['mode']): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.configure', { mode });
  }

  retryTelemetryDeletion(): Promise<TelemetryState> {
    return this.#telemetryCall('telemetry.retryForget', {});
  }

  exportTelemetry(): Promise<Record<string, unknown>> {
    return this.#telemetryCall('telemetry.export', {});
  }

  async #telemetryCall<M extends 'telemetry.state' | 'telemetry.configure' | 'telemetry.retryForget' | 'telemetry.export'>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    const client = this.#client;
    try {
      if (!client || !this.owner) throw new Error(strings.rightPanel.ownerOnly);
      return await client.call(method, params);
    } catch (error) {
      if (this.#client === client) this.#fail(error);
      throw error;
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

  /**
   * The list is the core's and arrives again as `providers.updatesChanged`.
   * A core from before updates answers MethodNotFound: that machine simply
   * offers none, which is not an error worth a toast.
   */
  async loadHarnessUpdates(refresh = false): Promise<void> {
    const client = this.#client;
    if (!client || !this.owner) return;
    try {
      const updates = await client.call('providers.updates', refresh ? { refresh: true } : {});
      if (client === this.#client) this.harnessUpdates = updates;
    } catch (error) {
      if (error instanceof RpcFailure && error.code === RpcErrorCode.MethodNotFound) return;
      if (refresh) this.#fail(error);
      else console.warn('reading the agent updates failed', error);
    }
  }

  async updateHarness(providerId: ProviderId): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      const update = await client.call('providers.update', { providerId });
      this.#putHarnessUpdate(update);
    } catch (error) {
      this.#fail(error);
    }
  }

  async skipHarnessUpdate(providerId: ProviderId, version: string | null): Promise<void> {
    const client = this.#client;
    if (!client) return;
    try {
      this.#putHarnessUpdate(await client.call('providers.updateSkip', { providerId, version }));
    } catch (error) {
      this.#fail(error);
    }
  }

  #putHarnessUpdate(update: HarnessUpdate): void {
    this.harnessUpdates = this.harnessUpdates.some((entry) => entry.providerId === update.providerId)
      ? this.harnessUpdates.map((entry) => (entry.providerId === update.providerId ? update : entry))
      : [...this.harnessUpdates, update];
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
    const delegated = this.#delegationSubscribedThreadId;
    this.#delegationSelectionEpoch++;
    this.#subscribedThreadId = null;
    this.#delegationSubscribedThreadId = null;
    this.delegationSelectedAgentId = null;
    this.delegationThread = null;
    if (!client || (!previous && !delegated)) return;
    const ids = [...new Set([previous, delegated].filter((id): id is string => id !== null))];
    await Promise.all(ids.map(threadId => client.call('threads.unsubscribe', { threadId }).catch(() => undefined)));
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

  #threadSnapshots(threadId: ThreadId): Set<Thread> {
    return new Set([this.openThread, this.delegationThread].filter((thread): thread is Thread => thread?.id === threadId));
  }

  #messages(threadId: ThreadId, messageId: string): Set<Message> {
    const messages = new Set<Message>();
    for (const thread of this.#threadSnapshots(threadId)) {
      const message = thread.messages.find((m) => m.id === messageId);
      if (message) messages.add(message);
    }
    return messages;
  }

  #upsertTurn(threadId: ThreadId, turn: Thread['turns'][number]): void {
    for (const thread of this.#threadSnapshots(threadId)) {
      const index = thread.turns.findIndex((t) => t.id === turn.id);
      if (index >= 0) thread.turns[index] = turn;
      else thread.turns.push(turn);
    }
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

  /**
   * The sentence one failure reads as, whether it lands in a surface or the
   * toast. The JSON-RPC code used to ride along as `(-32011)`: it says nothing
   * to the person reading the toast, and every refusal already names what to
   * do. It belongs in the console, which `#fail` writes it to.
   */
  #reason(error: unknown): string {
    if (error instanceof RpcFailure) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
  }

  #fail(error: unknown): void {
    if (error instanceof RpcFailure) console.error(`rpc ${error.code}: ${error.message}`, error);
    else console.error(error);
    this.error = this.#reason(error);
  }
}

export const store = new Store();
