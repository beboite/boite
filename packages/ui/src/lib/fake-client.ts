import {
  attachmentError,
  KEYBINDING_COMMANDS,
  MESSAGE_PAGE,
  MESSAGE_PAGE_MAX,
  PANEL_SURFACE_KINDS,
  parseChord,
  PROTOCOL_VERSION,
  RpcErrorCode,
  TODO_STATUSES,
  type Account,
  type BrainStatus,
  type AccountQuota,
  type AgentLetter,
  type AgentTask,
  type AgentWhere,
  type Attachment,
  type CoordinationConfig,
  type CoordinationPeer,
  type CoordinationView,
  type CoreInfo,
  type FileContent,
  type FileEntry,
  type GitDiff,
  type GitStatus,
  type HarnessUpdate,
  type ImportableSession,
  type Keybindings,
  type Message,
  type MessageId,
  type MessagePart,
  type ModelInfo,
  type PairedSession,
  type PanelSurface,
  type PermissionRequest,
  type Principal,
  type ProcessRecord,
  type Project,
  type ProviderInstallState,
  type ProviderSummary,
  type QuestionAnswer,
  type QuestionRequest,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type SchedulerState,
  type Settings,
  type SpeechConfig,
  type SpeechStatus,
  type Thread,
  type ThreadActivity,
  type ThreadId,
  type ThreadResources,
  type ThreadSummary,
  type Todo,
  type ToolDocument,
  type Turn,
  type Usage,
} from '@boite/contracts';
import { decodedBytes } from './attachments';
import { RpcFailure, type ClientState, type EventHandler, type ObservableClient } from './client';
import { seedAccounts } from './fake-client/accounts-seed';
import {
  DIFF_NEW,
  DIFF_OLD,
  DIFF_PATH,
  DOC_TEXT,
  DOC_TITLE,
  IMAGE_BASE64,
  QUESTION_OPTIONS,
  QUESTION_TEXT,
  SPAWN_MARKER,
  STREAMED_TOOL_INPUT
} from './fake-client/conversation.ts';
import {
  FAKE_CHANGES,
  FAKE_DIFFS,
  FAKE_FILES,
  FAKE_MEDIA,
  FAKE_MEDIA_PATHS,
  FAKE_TREE,
  fakeBytes,
  fakeLanguage,
  scoreFakeFile,
} from './fake-client/files.ts';
import { FakePlugins } from './fake-client/plugins';
import {
  FAKE_CONTEXT_FLOOR,
  FAKE_CONTEXT_PER_TURN,
  FAKE_CONTEXT_WINDOW,
  IMPORT_LIST_MS,
  INSTALL_STEP_MS,
  INSTALL_STEPS,
  MANAGED_ARCHIVE_BYTES,
  MANAGED_EXE,
  MANAGED_ID,
  MANAGED_VERSION,
  MUSE_EFFORT,
  PROBE_MS,
  PROBED_MODELS,
  RELEASES,
  RETITLE_DELAY_MS,
  UPDATABLE_ID
} from './fake-client/providers.ts';
import {
  addUsage,
  chunkText,
  DATA_DIR,
  DEVICE_METHODS,
  ECHO_COMMANDS,
  emptyUsage,
  fakeWorktree,
  refusal,
  SHOUT,
  T0,
  todoText,
  toSummary,
} from './fake-client/shared.ts';
import { longThread, seedThreads } from './fake-client/threads-seed';
import { fakeUsageHistory, type FakeFinishedTurn } from './fake-usage';

type FakeMethods = { [M in Exclude<RpcMethodName, `plugins.${string}` | `browser.${string}`>]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export interface FakeClientOptions {
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
  /** A fresh machine with no agents or accounts, for the setup flow. */
  uninstalled?: boolean;
  /** An installed browser plugin with a running task, for rendered UI checks. */
  browserTask?: boolean;
  /** Who this client is. `'session'` makes it a paired phone, refused like one. */
  principal?: Principal;
  /** Stable public identity for multi-machine coordination tests. */
  coreId?: string;
  coreName?: string;
  publicUrl?: string;
}

/** Keep update notices out of ordinary demo fixtures. */
function quietUpdates(): boolean {
  if (typeof location === 'undefined') return false;
  const query = new URLSearchParams(location.search);
  return query.get('fake') === '1' && query.get('updates') !== '1';
}

export class FakeClient implements ObservableClient {
  #brain: BrainStatus = { config: { path: null, enabled: false }, entries: [], problems: [], git: null, lastSync: null };
  #telemetry: import('@boite/contracts').TelemetryState = { mode: 'basic', configured: true, pendingDeletion: false };
  #plugins = new FakePlugins({
    emit: (event, payload) => this.#emit(event, payload),
    now: () => this.#now(),
    nextId: () => ++this.#seq,
    delayMs: () => this.#delayMs,
    requireThread: id => this.#thread(id),
  });
  static #cores = new Map<string, FakeClient>();
  #state: ClientState = 'idle';
  #handlers = new Map<string, Set<(payload: unknown) => void>>();
  #stateHandlers = new Set<(state: ClientState) => void>();
  /** What the core has this socket subscribed to: what `#emitToThread` reads. */
  #subscribed = new Set<ThreadId>();
  /** `WsClient.#subscribed`'s mirror: the ids the client itself puts back after a reconnect. */
  #clientSubscribed = new Set<ThreadId>();
  /** The calls the socket is holding, so `drop()` can reject them from underneath. */
  #pending = new Set<{ reject: (error: RpcFailure) => void }>();

  #projects: Project[] = [];
  /** The sessions Claude Code kept, each tagged with the project whose folder it sits under. */
  #importable: (ImportableSession & { projectId: string })[] = [];
  #providers: ProviderSummary[] = [];
  #modelCatalogs = new Map<string, ModelInfo[]>();
  /** Where each managed install stood before the running one started, for a cancel. */
  #installBefore = new Map<string, ProviderInstallState>();
  #accounts: Account[] = [];
  #threads = new Map<ThreadId, Thread>();
  #coordination = new Map<ThreadId, CoordinationConfig>();
  #letters = new Map<ThreadId, AgentLetter[]>();
  #peers = new Map<string, CoordinationPeer>();
  #identity: CoordinationPeer;
  #activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #activityTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number }>();
  #activityGenerations = new Map<string, number>();
  #processes: ProcessRecord[] = [];
  #usage = new Map<ThreadId, Usage>();
  /** Turns this session finished, added to the seeded ledger `usage.history` draws. */
  #finished: FakeFinishedTurn[] = [];
  #usageSeeded = true;
  /** The project todo lists, every thread of a project reading the same cards. */
  #todos: Todo[] = [];
  /** The working tree `files.list`, `files.read` and `files.write` share. */
  #files = new Map<string, string>(Object.entries(FAKE_TREE));
  #settings: Settings;
  #speech: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
  #speechStatus: SpeechStatus = { revision: 'fake-voice', engine: 'local', ready: true, localReady: true, groqKeySet: false, openrouterKeySet: false, installing: false, downloadedBytes: 0, totalBytes: 190085487, error: null, canInstallRuntime: true };
  #speechRequests = new Map<string, symbol>();
  /** A file with one moved chord, one taken away, and one line the core refused. */
  #keybindings: Keybindings = {
    path: `${DATA_DIR}\\keybindings.json`,
    bindings: { 'theme-light': 'mod+shift+l', panel: null },
    errors: ['keybindings.json: "trace": "t" has no modifier: a chord needs mod, ctrl, alt or meta before its key']
  };
  #quotaEnabled: Record<string, boolean> = {};
  #scheduler: SchedulerState;
  #core: CoreInfo;
  /** One phone already paired, so the devices list has a row to revoke. */
  #sessions: PairedSession[] = [
    { id: 'ses-phone', client: { name: 'pwa', version: '2.0.0-beta.1' }, role: 'device', createdAt: T0, lastSeenAt: T0 + 600_000, current: false },
    { id: 'ses-laptop', client: { name: 'shell', version: '2.0.0-beta.1' }, role: 'owner', createdAt: T0, lastSeenAt: T0 + 300_000, current: false }
  ];

  /** The request itself is kept beside its resolver, which is what `permissions.list` answers with. */
  #pendingPermissions = new Map<
    string,
    { request: PermissionRequest; resolve: (decision: 'allow' | 'deny') => void }
  >();
  /** Same shape for the questions: the request kept beside what settles it. */
  #pendingQuestions = new Map<
    string,
    { request: QuestionRequest; resolve: (answer: QuestionAnswer | null) => void }
  >();
  #inFlight = new Map<ThreadId, { cancelled: boolean; done: Promise<void> }>();
  /** The current output of every active fake login, also returned after reconnect. */
  #logins = new Map<string, RpcEvents['account.login']>();
  #seq = 0;
  #turnRequests = new Map<string, { content: string; turn: Turn }>();
  #delayMs: number;
  #long: boolean;
  #principal: Principal;

  constructor(options: FakeClientOptions = {}) {
    this.#delayMs = options.delayMs ?? 18;
    this.#long = options.long ?? false;
    this.#principal = options.principal ?? 'owner';
    const coreId = options.coreId ?? `fake-core-${crypto.randomUUID()}`;
    this.#identity = {
      coreId,
      name: options.coreName ?? 'This PC',
      url: options.publicUrl ?? 'http://127.0.0.1:8777',
      publicKey: `fake-public-key-${coreId}`
    };
    FakeClient.#cores.set(coreId, this);
    this.#settings = {
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 5,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
      focusGuard: true,
      muteAgents: true,
      autoUpdateHarnesses: false
    };
    this.#core = {
      version: '2.0.0-beta.1',
      protocolVersion: PROTOCOL_VERSION,
      os: 'windows',
      channel: 'stable',
      pid: 4242,
      startedAt: T0,
      endpoint: { host: '127.0.0.1', port: 8777 },
      dataDir: DATA_DIR,
      trace: {
        os: 'windows',
        mode: 'events',
        note: 'Job object completion port: every process this thread launched is reported exactly, including the ones its children launched.'
      }
    };
    this.#scheduler = {
      maxConcurrentTurns: this.#settings.maxConcurrentTurns,
      perAccountConcurrency: this.#settings.perAccountConcurrency,
      running: [],
      queued: []
    };
    this.#seed();
    if (options.browserTask) this.#plugins.seedBrowserTask();
    if (options.uninstalled) {
      this.#providers = this.#providers.filter(provider => provider.id !== 'echo').map(provider => ({
        ...provider, available: false, executable: null,
        install: RELEASES[provider.id] ? { state: 'absent', ...RELEASES[provider.id]! } : null,
      }));
      this.#accounts = [];
      this.#threads.clear();
      this.#importable = [];
      this.#pendingPermissions.clear();
      this.#pendingQuestions.clear();
      this.#processes = [];
      this.#todos = [];
      this.#usage.clear();
      this.#usageSeeded = false;
      this.#scheduler = { ...this.#scheduler, running: [], queued: [] };
    }
  }

  // -------------------------------------------------------------------------
  // Client surface
  // -------------------------------------------------------------------------

  get state(): ClientState {
    return this.#state;
  }

  get core(): CoreInfo | null {
    return this.#state === 'ready' ? this.#core : null;
  }

  /**
   * Who the core says this client is, `null` until `hello` has answered, which
   * is what the real `WsClient` reports. The fake is the desktop owner unless
   * it was built with `{ principal: 'session' }`, the paired phone.
   */
  get principal(): Principal | null {
    return this.#state === 'ready' ? this.#principal : null;
  }

  /**
   * Turns this client into a paired device, or back into the owner, in the
   * spirit of `drop` and `restore`: the boundary is the core's, so a test can
   * cross it without a second socket. `hello` and every later call answer as
   * the new principal from here on.
   */
  becomes(principal: Principal): void {
    this.#principal = principal;
  }

  onState(handler: (state: ClientState) => void): () => void {
    this.#stateHandlers.add(handler);
    return () => this.#stateHandlers.delete(handler);
  }

  on<E extends RpcEventName>(event: E, handler: EventHandler<E>): () => void {
    let set = this.#handlers.get(event);
    if (!set) {
      set = new Set();
      this.#handlers.set(event, set);
    }
    const erased = handler as (payload: unknown) => void;
    set.add(erased);
    return () => {
      set.delete(erased);
    };
  }

  async connect(): Promise<CoreInfo> {
    this.#setState('connecting');
    await this.#tick();
    this.#setState('ready');
    return this.#core;
  }

  close(): void {
    if (FakeClient.#cores.get(this.#identity.coreId) === this) FakeClient.#cores.delete(this.#identity.coreId);
    for (const thread of this.#threads.values()) this.#pauseActivity(thread);
    this.#plugins.close();
    this.#setState('closed');
    this.#dropPending('client closed');
  }

  /**
   * The socket going away under the app, what `WsClient` does from
   * `socket.onclose`: every call it was holding rejects with the transport's
   * own failure, the state falls back to `connecting`, and the core's events
   * of that gap reach nobody. The core keeps running behind it.
   */
  drop(): void {
    if (this.#state !== 'ready') return;
    this.#setState('connecting');
    this.#dropPending('connection closed');
  }

  /** The socket back and the hello answered, `#resubscribe` included. */
  async restore(): Promise<CoreInfo> {
    if (this.#state === 'ready') return this.#core;
    this.#setState('connecting');
    await this.#tick();
    this.#setState('ready');
    // `WsClient.#resubscribe` sends one `threads.subscribe` per id it kept.
    for (const threadId of this.#clientSubscribed) this.#subscribed.add(threadId);
    return this.#core;
  }

  /** The ids the core holds this socket on, the set `#emitToThread` gates on. */
  get coreSubscribers(): ThreadId[] {
    return [...this.#subscribed];
  }

  /** The ids the client would resubscribe after a reconnect. */
  get clientSubscriptions(): ThreadId[] {
    return [...this.#clientSubscribed];
  }

  async call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.#state !== 'ready' && method !== 'hello') {
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'not connected' });
    }
    await this.#tick();
    // The router's gate, word for word: deny by default, `hello` before it.
    if (this.#principal === 'session' && method !== 'hello' && !DEVICE_METHODS.has(method)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${method} is for the owner only` });
    }
    const result = await this.#hold(this.#dispatch(method, params)) as RpcResult<M>;
    // The real client writes its set from the answer, never from the request.
    if (method === 'threads.subscribe') {
      this.#clientSubscribed.add((params as RpcParams<'threads.subscribe'>).threadId);
    } else if (method === 'threads.unsubscribe') {
      this.#clientSubscribed.delete((params as RpcParams<'threads.unsubscribe'>).threadId);
    }
    return result;
  }

  /**
   * One tick of the core's load sampler (`packages/core/src/procs.ts`): the
   * thread's summary with a fresh `load` and the timestamp it already had,
   * pushed once a second for every thread with a live process. It is not a
   * `#touch`: a load sample moves no row in the sidebar.
   */
  sampleLoad(threadId: ThreadId, processes = 1): void {
    const thread = this.#thread(threadId);
    thread.load = { processes, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#emit('thread.updated', structuredClone(toSummary(thread)));
  }

  /**
   * What the core's recovery does to a thread whose turn it ends: every
   * request still waiting is settled and dropped, the question with a null
   * answer and the permission with a deny (`packages/core/src/threads.ts`).
   */
  clearRequestsOf(threadId: ThreadId): void {
    for (const [questionId, pending] of [...this.#pendingQuestions]) {
      if (pending.request.threadId !== threadId) continue;
      this.#pendingQuestions.delete(questionId);
      this.#emit('question.answered', { questionId, threadId, answer: null });
      pending.resolve(null);
    }
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.request.threadId !== threadId) continue;
      this.#pendingPermissions.delete(requestId);
      this.#emit('permission.resolved', { requestId, threadId, decision: 'deny' });
      pending.resolve('deny');
    }
  }

  /** Resolves when no turn is still streaming. A pending permission blocks it. */
  async settled(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.all([...this.#inFlight.values()].map((entry) => entry.done));
    }
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  #dispatch(method: RpcMethodName, rawParams: unknown): Promise<unknown> {
    if (this.#plugins.handles(method)) return this.#plugins.call(method, rawParams);
    if (!Object.hasOwn(this.#methods, method)) {
      return Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: `unknown method ${String(method)}` }));
    }
    const handler = this.#methods[method];
    return handler(rawParams as never);
  }

  // Every method's input and output are checked against the real RPC contract.
  #methods: FakeMethods = {
    'brain.status': async () => structuredClone(this.#brain),
    'brain.configure': async (config) => {
        if (typeof config.enabled !== 'boolean' || (config.enabled && !config.path) || (config.path !== null && (typeof config.path !== 'string' || !/^(?:[A-Za-z]:[\\/]|\/)/.test(config.path)))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.path must be an absolute folder path or null; enabled must be a boolean' });
        const autoPull = config.autoPull === undefined ? this.#brain.config.autoPull : config.autoPull;
        const globalInstructions = config.globalInstructions === undefined ? this.#brain.config.globalInstructions : config.globalInstructions;
        if (globalInstructions !== undefined && typeof globalInstructions !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.globalInstructions must be a boolean' });
        if (autoPull !== undefined && (!autoPull || typeof autoPull.onStartup !== 'boolean' || !Number.isInteger(autoPull.intervalMinutes) || autoPull.intervalMinutes < 0 || autoPull.intervalMinutes > 1440)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'brain.autoPull.onStartup must be a boolean; intervalMinutes must be an integer from 0 to 1440' });
        if (this.#brain.config.path !== config.path) this.#brain.lastSync = null;
        this.#brain.config = { ...config, ...(autoPull ? { autoPull: { ...autoPull } } : {}), ...(globalInstructions !== undefined ? { globalInstructions } : {}) };
        this.#brain.links = config.path && config.enabled && globalInstructions ? [
          ['Claude Code', '.claude/CLAUDE.md'], ['Codex', '.codex/AGENTS.md'], ['OpenCode', '.config/opencode/AGENTS.md'],
          ['pi', '.pi/agent/AGENTS.md'], ['Grok', '.grok/AGENTS.md'], ['Gemini / Antigravity', '.gemini/GEMINI.md'], ['Muse', '.config/muse/AGENTS.md'],
        ].map(([name, path]) => ({ name: name!, path: `/home/user/${path}`, state: 'linked' as const, error: null })) : [];
        this.#brain.entries = config.path ? [
          { kind: 'instructions', name: 'AGENTS.md', path: 'AGENTS.md', description: '', error: null },
          { kind: 'skill', name: 'code-review', path: 'skills/code-review/SKILL.md', description: 'Review changes and check the affected behavior.', error: null },
          { kind: 'plugin', name: 'team-tools', path: 'plugins/team-tools/.claude-plugin/plugin.json', description: 'Shared tools for the team.', error: null },
        ] : [];
        this.#brain.git = config.path ? { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: false } : null;
        return structuredClone(this.#brain);
    },
    'brain.sync': async () => {
        if (!this.#brain.git) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'brain.path must point to the root of a Git checkout to synchronize' });
        this.#brain.lastSync = Date.now();
        return structuredClone(this.#brain);
    },
    'quotas.configure': async (params) => {
      this.#quotaEnabled[params.accountId] = params.enabled;
      const rows = this.#quotas(); this.#emit('quotas.updated', rows); return rows;
    },
    'quotas.list': async (params) => {
      return this.#quotas();
    },
    'hello': async (params) => {
      return { core: this.#core, principal: this.#principal };
    },
    'pairing.grant': async (params) => {
      const grant = `fake-grant-${++this.#seq}`;
      return {
        url: `http://192.168.1.20:8777/?grant=${grant}`,
        grant,
        role: params?.role ?? 'device',
        expiresAt: this.#now() + 10 * 60 * 1000
      };
    },
    'sessions.list': async (params) => {
      return structuredClone(this.#sessions);
    },
    'push.status': async (params) => {
      return { publicKey: '', subscribed: false };
    },
    'push.subscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.unsubscribe': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'push.test': async (params) => {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Web Push needs a paired connection to a real core' });
    },
    'sessions.revoke': async (params) => {
      if (!this.#sessions.some((session) => session.id === params.sessionId)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `unknown session ${params.sessionId}` });
      }
      this.#sessions = this.#sessions.filter((session) => session.id !== params.sessionId);
      this.#emit('sessions.updated', { sessionId: params.sessionId, state: 'revoked' });
      return { ok: true };
    },
    'projects.list': async (params) => {
      return structuredClone(this.#projects);
    },
    'projects.browse': async (params) => {
      const { path = '/workspace' } = params;
      return {
        path, parent: path === '/' ? null : '/', directories: path === '/workspace' ? [
          { name: 'boite', path: '/workspace/boite' }, { name: 'notes', path: '/workspace/notes' }
        ] : []
      };
    },
    'projects.add': async (params) => {
      const project: Project = {
        id: `p-${++this.#seq}`,
        name: params.name ?? params.path.split(/[\\/]/).filter(Boolean).pop() ?? params.path,
        path: params.path,
        createdAt: this.#now()
      };
      this.#projects.push(project);
      this.#emit('project.added', structuredClone(project));
      return structuredClone(project);
    },
    'threads.pullRequest': async (params) => {
      const thread = this.#threads.get(params.threadId);
      return thread?.pullRequest ?? null;
    },
    'projects.remove': async (params) => {
      this.#projects = this.#projects.filter((p) => p.id !== params.projectId);
      const threads = [...this.#threads.values()].filter((thread) => thread.projectId === params.projectId);
      for (const thread of threads) thread.archived = true;
      await Promise.all(threads.map((thread) => this.#stopTurn(thread.id)));
      for (const thread of threads) {
        this.#threads.delete(thread.id);
        this.#emit('thread.removed', { threadId: thread.id });
      }
      this.#emit('project.removed', { projectId: params.projectId });
      return { ok: true };
    },
    'projects.files': async (params) => {
      if (!this.#projects.some((p) => p.id === params.projectId)) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown project ${params.projectId}` });
      }
      const limit = Math.max(1, Math.min(200, params.limit ?? 50));
      const scored = FAKE_FILES.map((path) => ({ path, score: scoreFakeFile(params.query, path) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
      return { files: scored.slice(0, limit).map((entry) => entry.path), total: scored.length, capped: false };
    },
    'providers.list': async (params) => {
      return { loaded: structuredClone(this.#providers), rejected: [] };
    },
    'providers.reload': async (params) => {
      for (const provider of this.#providers) {
        if (!provider.available || this.#accounts.some(account => account.providerId === provider.id)) continue;
        const id = `a-${++this.#seq}`;
        const account: Account = {
          id, providerId: provider.id, label: 'Default',
          isolationDir: provider.alwaysIsolated ? `${DATA_DIR}/accounts/${id}` : null,
          status: provider.alwaysIsolated ? 'unauthenticated' : 'ok', identity: null, createdAt: this.#now(),
        };
        this.#accounts.push(account);
        this.#emit('accounts.updated', structuredClone(account));
      }
      const result = { loaded: structuredClone(this.#providers), rejected: [] };
      this.#emit('providers.updated', structuredClone(result));
      return result;
    },
    'providers.probe': async (params) => {
      // The fixture catalogue already carries each model's own scale, so a probe
      // naming a model answers the same list; only the refusal is mirrored.
      if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length === 0)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'model must be a non-empty string when given', data: { field: 'model', expected: 'a non-empty string' } });
      }
      return this.#probe(params.providerId, params.accountId);
    },
    'providers.install': async (params) => {
      return this.#startInstall(params.providerId);
    },
    'providers.installCancel': async (params) => {
      return this.#cancelInstall(params.providerId, params.operationId);
    },
    'providers.uninstall': async (params) => {
      return this.#uninstall(params.providerId);
    },
    'providers.updates': async (params) => {
      return structuredClone(this.#harnessUpdates);
    },
    'providers.update': async (params) => {
      return this.#updateHarness(params.providerId);
    },
    'providers.updateSkip': async (params) => {
      const update = this.#harnessUpdate(params.providerId);
      update.skipped = params.version;
      update.pending = update.latest !== update.current && update.skipped !== update.latest;
      this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
      return structuredClone(update);
    },
    'providers.dryRun': async (params) => {
      const provider = this.#providers[0];
      if (!params.file.endsWith('.json') || !provider) {
        return {
          ok: false,
          rejected: {
            file: params.file,
            field: 'file',
            expected: 'a path ending in .json',
            message: 'not a descriptor file'
          }
        };
      }
      return {
        ok: true,
        summary: structuredClone(provider),
        plan: { roots: [DATA_DIR], env: ['BOITE_ISOLATION_DIR'], closes: [] }
      };
    },
    'accounts.list': async (params) => {
      return structuredClone(this.#accounts);
    },
    'accounts.add': async (params) => {
      const provider = this.#providers.find((p) => p.id === params.providerId);
      if (!provider) throw this.#notFound('provider', params.providerId);
      const id = `a-${++this.#seq}`;
      const account: Account = {
        id,
        providerId: params.providerId,
        label: params.label,
        isolationDir: params.useDefaultLocation && !provider.alwaysIsolated ? null : `${DATA_DIR}\\accounts\\${id}`,
        status: 'unknown',
        identity: null,
        createdAt: this.#now()
      };
      this.#accounts.push(account);
      this.#emit('accounts.updated', structuredClone(account));
      return structuredClone(account);
    },
    'accounts.remove': async (params) => {
      if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
      const referenced = [...this.#threads.values()].find((t) => t.accountId === params.accountId);
      if (referenced) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `account ${params.accountId} is used by thread ${referenced.id}` });
      }
      this.#cancelLogin(params.accountId);
      this.#accounts = this.#accounts.filter((a) => a.id !== params.accountId);
      this.#emit('accounts.removed', { accountId: params.accountId });
      return { ok: true };
    },
    'accounts.check': async (params) => {
      const account = this.#accounts.find((a) => a.id === params.accountId);
      if (!account) throw this.#notFound('account', params.accountId);
      account.status = account.isolationDir === null ? 'ok' : 'unauthenticated';
      account.identity = account.status === 'ok' ? 'you@example.com' : null;
      this.#emit('accounts.updated', structuredClone(account));
      return structuredClone(account);
    },
    'accounts.login': async (params) => {
      const account = this.#accounts.find((a) => a.id === params.accountId);
      if (!account) throw this.#notFound('account', params.accountId);
      const provider = this.#providers.find((p) => p.id === account.providerId);
      if (!provider?.available || !provider.login) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `login is not available for ${account.providerId}` });
      }
      if (account.isolationDir === null) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `${account.label} uses the provider's own location: log it in with your own CLI, outside Boite`
        });
      }
      if (this.#logins.has(account.id)) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `a login is already running for ${account.label}`
        });
      }
      this.#loginEvent({
        accountId: account.id,
        state: 'running',
        output: '',
        url: null,
        exitCode: null
      });
      void this.#fakeLoginPrompt(account.id);
      return { ok: true };
    },
    'accounts.logins': async (params) => {
      return structuredClone([...this.#logins.values()]);
    },
    'accounts.loginCancel': async (params) => {
      if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
      this.#cancelLogin(params.accountId);
      return { ok: true };
    },
    'accounts.loginInput': async (params) => {
      const account = this.#accounts.find((a) => a.id === params.accountId);
      if (!account) throw this.#notFound('account', params.accountId);
      if (!this.#logins.has(account.id)) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `no login is running for ${account.id}`
        });
      }
      void this.#finishFakeLogin(account);
      return { ok: true };
    },
    'threads.list': async (params) => {
      return [...this.#threads.values()]
        .filter((t) => (params.projectId ? t.projectId === params.projectId : true))
        .filter((t) => (params.includeArchived ? true : !t.archived))
        .map((t) => structuredClone(toSummary(t)));
    },
    'threads.create': async (params) => {
      if (!this.#providers.some(provider => provider.id === params.providerId)) throw this.#notFound('provider', params.providerId);
      const project = this.#projects.find((p) => p.id === params.projectId);
      if (!project) throw this.#notFound('project', params.projectId);
      this.#checkSpeed(params.providerId, params.accountId, params.model ?? null, params.speed ?? null);
      const at = this.#now();
      const title = params.title ?? 'Untitled thread';
      // The core's own placement: a branch named after the title, the
      // worktree beside the repository. No git here, only the two strings.
      const placed = params.worktree === undefined ? null : fakeWorktree(project.path, title, params.worktree.branch);
      const thread: Thread = {
        id: `t-${++this.#seq}`,
        projectId: params.projectId,
        title,
        titleSource: 'prompt',
        providerId: params.providerId,
        accountId: params.accountId,
        model: params.model ?? null,
        effort: params.effort ?? null,
        speed: params.speed ?? null,
        cwd: placed?.path ?? params.cwd ?? project.path,
        branch: placed?.branch ?? null,
        permissionMode: params.permissionMode ?? 'default',
        status: 'idle',
        unread: false,
        archived: false,
        pinned: false,
        sessionId: null,
        load: null,
        context: null,
        createdAt: at,
        updatedAt: at,
        messages: [],
        commands: [],
        messagesBefore: null,
        turns: []
      };
      this.#threads.set(thread.id, thread);
      this.#emit('thread.created', structuredClone(toSummary(thread)));
      return structuredClone(toSummary(thread));
    },
    'threads.get': async (params) => {
      const thread = this.#thread(params.threadId);
      // The core's rule: from the named message on, unless it is unknown or
      // the tail is longer than a page, and then the whole page as before.
      const from = params.after === undefined ? -1 : thread.messages.findIndex((message) => message.id === params.after);
      if (from !== -1 && thread.messages.length - from <= MESSAGE_PAGE) {
        const messages = thread.messages.slice(from);
        // As the core's `listTurnsFor`: the turns of the messages sent, and whatever is still queued or running.
        const sent = new Set(messages.map((message) => message.turnId));
        const turns = thread.turns.filter((turn) => turn.status === 'queued' || turn.status === 'running' || sent.has(turn.id));
        return structuredClone({ ...thread, messages, turns, messagesBefore: null, messagesFrom: params.after });
      }
      const page = this.#page(thread.messages, thread.messages.length, MESSAGE_PAGE);
      return structuredClone({ ...thread, messages: page.messages, messagesBefore: page.before });
    },
    'messages.list': async (params) => {
      const thread = this.#thread(params.threadId);
      const at = thread.messages.findIndex((message) => message.id === params.before);
      if (at < 0) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: `message ${params.before} is not a message of thread ${params.threadId}`,
          data: { threadId: params.threadId, before: params.before }
        });
      }
      const asked = params.limit ?? MESSAGE_PAGE;
      const limit = Math.min(Math.max(1, Math.trunc(asked)), MESSAGE_PAGE_MAX);
      const page = this.#page(thread.messages, at, limit);
      const turns = new Set(page.messages.map((message) => message.turnId));
      return structuredClone({ ...page, turns: thread.turns.filter((turn) => turns.has(turn.id)) });
    },
    'threads.update': async (params) => {
      const thread = this.#thread(params.threadId);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      }
      const nextAccountId = params.accountId ?? thread.accountId;
      const nextProviderId = this.#accounts.find(a => a.id === nextAccountId)?.providerId ?? thread.providerId;
      const changedModel = (params.model !== undefined && params.model !== thread.model) || nextAccountId !== thread.accountId;
      this.#checkSpeed(nextProviderId, nextAccountId, params.model !== undefined ? params.model : thread.model, params.speed !== undefined ? params.speed : changedModel ? null : thread.speed ?? null);
      const before = [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0');
      if (params.accountId !== undefined && params.accountId !== thread.accountId) {
        const account = this.#accounts.find((entry) => entry.id === params.accountId);
        const provider = account && this.#providers.find((entry) => entry.id === account.providerId);
        if (!account || !provider?.available || account.status === 'unauthenticated') {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the selected account is unavailable' });
        }
        thread.accountId = account.id;
        thread.providerId = account.providerId;
        thread.model = params.model === undefined ? provider.models.find((model) => model.default)?.id ?? null : params.model;
        thread.effort = null; thread.speed = null;
        thread.sessionId = null;
        thread.sessionGeneration = (thread.sessionGeneration ?? 0) + 1;
        thread.context = null;
        thread.commands = [];
        this.#emit('thread.commands', { threadId: thread.id, commands: [] });
      }
      if (params.title !== undefined) {
        thread.title = params.title;
        thread.titleSource = 'user';
      }
      if (params.model !== undefined && params.model !== thread.model) { thread.model = params.model; thread.effort = null; thread.speed = null; }
      if (params.effort !== undefined) thread.effort = params.effort;
      if (params.speed !== undefined) thread.speed = params.speed;
      if (params.permissionMode !== undefined) thread.permissionMode = params.permissionMode;
      if (before !== [thread.accountId, thread.model, thread.effort, thread.speed, thread.permissionMode].join('\0')) thread.selectionVersion = (thread.selectionVersion ?? 0) + 1;
      return this.#touch(thread);
    },
    'threads.retitle': async (params) => {
      const thread = this.#thread(params.threadId);
      const first = thread.messages.find((message) => message.role === 'user');
      if (first === undefined) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'this thread has no prompt to write a title from',
          data: { threadId: params.threadId }
        });
      }
      // The echo agent's rule, at the echo agent's pace: its prefix and the first five words.
      await new Promise<void>((resolve) => setTimeout(resolve, RETITLE_DELAY_MS));
      const words = first.parts
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(' ')
        .split(/\s+/)
        .filter((word) => word.length > 0);
      thread.title = `Echo: ${words.slice(0, 5).join(' ')}`;
      thread.titleSource = 'agent';
      return this.#touch(thread);
    },
    'threads.archive': async (params) => {
      const thread = this.#thread(params.threadId);
      thread.archived = params.archived ?? true;
      if (thread.archived) await this.#stopTurn(thread.id);
      return this.#touch(thread);
    },
    'threads.pin': async (params) => {
      const thread = this.#thread(params.threadId);
      const pinned = params.pinned ?? true;
      if (thread.pinned === pinned) return structuredClone(toSummary(thread));
      thread.pinned = pinned;
      return this.#touch(thread);
    },
    'threads.markRead': async (params) => {
      const thread = this.#thread(params.threadId);
      thread.unread = false;
      this.#touch(thread);
      return { ok: true };
    },
    'threads.subscribe': async (params) => {
      // The core runs `threads.require` first, so an unknown id is a NotFound.
      this.#thread(params.threadId);
      this.#subscribed.add(params.threadId);
      return { ok: true };
    },
    'threads.unsubscribe': async (params) => {
      this.#subscribed.delete(params.threadId);
      return { ok: true };
    },
    'turns.start': async (params) => {
      if (params.attachments !== undefined && (!Array.isArray(params.attachments) || params.attachments.some(a => !a || typeof a !== 'object'))) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'attachments must be an array of attachment objects' });
      const key = params.clientRequestId ? `${params.threadId}:${params.clientRequestId}` : null;
      const content = JSON.stringify([params.prompt, (params.attachments ?? []).map(a => [a.kind, a.mimeType, a.data, a.name])]);
      if (params.clientRequestId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(params.clientRequestId)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId must contain 8 to 128 URL-safe characters' });
      const previous = key ? this.#turnRequests.get(key) : undefined;
      if (previous) {
        if (previous.content !== content) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'clientRequestId was already used for different content' });
        return previous.turn;
      }
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (this.#thread(params.threadId).selectionVersion ?? 0)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed; review the selected model and send again' });
      }
      const providerId = this.#thread(params.threadId).providerId;
      const provider = this.#providers.find(p => p.id === providerId);
      if (!provider) throw this.#notFound('provider', providerId);
      const error = attachmentError(params.attachments ?? [], provider);
      if (error) throw new RpcFailure({ code: RpcErrorCode.Refused, ...error });
      const turn = this.#startTurn(params.threadId, params.prompt, params.attachments ?? []);
      if (key) this.#turnRequests.set(key, { content, turn });
      return turn;
    },
    'threads.activity.set': async (params) => {
      const thread = this.#thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'activity requires an unarchived thread' });
      const activity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
      if (params.goal !== undefined) {
        if (params.goal !== null && !params.goal.objective?.trim()) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'goal.objective must be non-empty text' });
        activity.goal = params.goal === null ? null : { objective: params.goal.objective.trim(), status: 'active', iterations: 0, error: null };
      }
      if (params.loop !== undefined) {
        if (params.loop !== null && (!params.loop.prompt?.trim() || !Number.isInteger(params.loop.intervalMs) || (params.loop.intervalMs < 1000 && !(params.loop.intervalMs === 0 && params.loop.maxIterations)) || params.loop.intervalMs > 86400000 || (params.loop.maxIterations != null && (!Number.isInteger(params.loop.maxIterations) || params.loop.maxIterations < 1 || params.loop.maxIterations > 1000)))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'loop requires text and an interval from 1000 to 86400000 ms, or 0 with 1 to 1000 iterations' });
        activity.loop = params.loop === null ? null : { prompt: params.loop.prompt.trim(), intervalMs: params.loop.intervalMs, maxIterations: params.loop.maxIterations ?? null, status: 'active', iterations: 0, nextRunAt: Date.now(), error: null, history: [] };
      }
      for (const kind of ['goal', 'loop'] as const) if (params[kind] !== undefined) {
        const key = `${thread.id}:${kind}`;
        this.#activityGenerations.set(key, (this.#activityGenerations.get(key) ?? 0) + 1);
      }
      thread.activity = activity;
      this.#publishActivity(thread);
      this.#scheduleActivity(thread.id);
      return structuredClone(activity);
    },
    'threads.activity.control': async (params) => {
      const thread = this.#thread(params.threadId);
      const activity = thread.activity;
      if (params.action === 'resume' && thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot resume activity on an archived thread' });
      const item = activity?.[params.kind];
      if (!activity || !item) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `this thread has no ${params.kind}` });
      if (params.action === 'complete' && params.kind !== 'goal') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'only a goal can be completed' });
      if (params.action === 'resume' && params.kind === 'loop' && activity.loop?.maxIterations && activity.loop.iterations >= activity.loop.maxIterations) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this loop has finished all its iterations' });
      if (params.action === 'remove') activity[params.kind] = null;
      else if (params.action === 'complete' && activity.goal) activity.goal.status = 'complete';
      else { item.status = params.action === 'resume' ? 'active' : 'paused'; item.error = null; if (params.kind === 'goal' && activity.goal) activity.goal.dismissed = false; }
      if (params.action === 'remove' || params.action === 'complete') {
        const key = `${thread.id}:${params.kind}`;
        this.#activityGenerations.set(key, (this.#activityGenerations.get(key) ?? 0) + 1);
      }
      if (activity.loop && activity.loop.status !== 'active') activity.loop.nextRunAt = null;
      if (params.kind === 'loop' && params.action === 'resume' && activity.loop) activity.loop.nextRunAt = Date.now();
      this.#publishActivity(thread);
      this.#scheduleActivity(thread.id);
      return structuredClone(activity);
    },
    'threads.compact': async (params) => {
      const thread = this.#thread(params.threadId);
      if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model selection changed' });
      if (!thread.sessionId) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread has no native session to compact' });
      if (this.#providers.find((p) => p.id === thread.providerId)?.protocol === 'acp' && !thread.commands.some((c) => c.name === 'compact')) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this agent has not advertised a compact command' });
      if (this.#providers.find((p) => p.id === thread.providerId)?.protocol === 'agy') throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the Antigravity CLI takes no /compact in print mode' });
      return this.#startTurn(params.threadId, '[compact]', [], 'compact');
    },
    'turns.stop': async (params) => {
      return { stopped: await this.#stopTurn(params.threadId) };
    },
    'permissions.list': async (params) => {
      const requests = [...this.#pendingPermissions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'permissions.answer': async (params) => {
      const pending = this.#pendingPermissions.get(params.requestId);
      if (!pending) throw this.#notFound('permission request', params.requestId);
      this.#pendingPermissions.delete(params.requestId);
      pending.resolve(params.decision);
      return { ok: true };
    },
    'questions.list': async (params) => {
      const requests = [...this.#pendingQuestions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'questions.answer': async (params) => {
      const pending = this.#pendingQuestions.get(params.questionId);
      if (!pending) throw this.#notFound('question', params.questionId);
      this.#pendingQuestions.delete(params.questionId);
      const text = params.text ?? '';
      const answer: QuestionAnswer =
        text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
      pending.resolve(answer);
      return { ok: true };
    },
    'trace.get': async (params) => {
      const rows = this.#processes
        .filter((p) => p.threadId === params.threadId)
        .sort((a, b) => b.startedAt - a.startedAt);
      return structuredClone(params.limit ? rows.slice(0, params.limit) : rows);
    },
    'resources.list': async (params) => {
      return structuredClone(this.#resources());
    },
    'resources.killTree': async (params) => {
      let killed = 0;
      for (const record of this.#processes) {
        if (record.threadId !== params.threadId || record.exitedAt !== null) continue;
        record.exitedAt = this.#now();
        record.exitCode = 1;
        killed += 1;
        this.#emit('process.exited', structuredClone(record));
      }
      const thread = this.#threads.get(params.threadId);
      if (thread) {
        thread.load = null;
        this.#touch(thread);
      }
      return { killed };
    },
    'scheduler.get': async (params) => {
      return structuredClone(this.#scheduler);
    },
    'usage.get': async (params) => {
      const byThread: Record<ThreadId, Usage> = {};
      let total = emptyUsage();
      for (const [threadId, usage] of this.#usage) {
        if (params.threadId && params.threadId !== threadId) continue;
        byThread[threadId] = { ...usage };
        total = addUsage(total, usage);
      }
      return { byThread, total };
    },
    'usage.history': async (params) => {
      const { edges } = params;
      const valid = Array.isArray(edges) && edges.length >= 2 && edges.length <= 367 &&
        edges.every((edge, index) => typeof edge === 'number' && Number.isFinite(edge) && (index === 0 || edge > edges[index - 1]!));
      if (!valid) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'edges: expected 2 to 367 strictly ascending timestamps in milliseconds' });
      return fakeUsageHistory(edges, { seeded: this.#usageSeeded, finished: this.#finished });
    },
    'telemetry.state': async () => ({ ...this.#telemetry }),
    'telemetry.configure': async ({ mode }) => {
      if (!['off', 'basic', 'enhanced'].includes(mode)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'mode: expected off, basic or enhanced' });
      if (this.#telemetry.mode === 'enhanced' && mode !== 'enhanced') this.#telemetry.pendingDeletion = true;
      this.#telemetry.mode = mode;
      return { ...this.#telemetry };
    },
    'telemetry.retryForget': async () => {
      this.#telemetry.pendingDeletion = false;
      return { ...this.#telemetry };
    },
    'telemetry.export': async () => {
      if (this.#telemetry.mode !== 'enhanced') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'telemetry export: expected enhanced mode' });
      return { events: [], truncated: false };
    },
    'settings.get': async (params) => {
      return { ...this.#settings };
    },
    'collaboration.get': async (params) => {
      const { threadId } = params;
      this.#thread(threadId);
      return this.#coordinationView(threadId);
    },
    'collaboration.configure': async (params) => {
      const { threadId, config } = params;
      this.#thread(threadId);
      if (!['off', 'brief', 'team'].includes(config.mode) || typeof config.resources !== 'string' || config.resources.length > 500 || typeof config.remote !== 'boolean' || typeof config.paused !== 'boolean') {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'config: expected mode, resources, remote and paused' });
      }
      this.#coordination.set(threadId, { ...config, resources: config.resources.trim() });
      this.#emit('collaboration.changed', { threadId });
      return this.#coordinationView(threadId);
    },
    'collaboration.directory': async (params) => {
      const { threadId } = params;
      const source = this.#thread(threadId);
      const sourceConfig = this.#coordinationConfig(threadId);
      if (sourceConfig.mode === 'off') return { agents: [], unavailable: [] };
      const agents = [...this.#threads.values()]
        .filter(thread => thread.id !== threadId && !thread.archived && (thread.projectId === source.projectId || sourceConfig.remote && this.#coordinationConfig(thread.id).remote))
        .map(thread => {
          const config = this.#coordinationConfig(thread.id);
          return {
            coreId: this.#identity.coreId,
            threadId: thread.id,
            title: thread.title,
            machine: this.#identity.name,
            resources: config.resources,
            status: thread.status,
            mode: config.mode
          };
        })
        .filter(agent => agent.mode !== 'off');
      const unavailable: string[] = [];
      if (sourceConfig.remote) for (const peer of this.#peers.values()) {
        const target = FakeClient.#cores.get(peer.coreId);
        if (!target || !target.#peers.has(this.#identity.coreId)) { unavailable.push(peer.name); continue; }
        for (const thread of target.#threads.values()) {
          const config = target.#coordinationConfig(thread.id);
          if (thread.archived || config.mode === 'off' || !config.remote) continue;
          agents.push({ coreId: peer.coreId, threadId: thread.id, title: thread.title, machine: peer.name, resources: config.resources, status: thread.status, mode: config.mode });
        }
      }
      return { agents, unavailable };
    },
    'collaboration.send': async (params) => {
      const source = this.#thread(params.threadId);
      const config = this.#coordinationConfig(source.id);
      if (config.mode === 'off' || config.paused) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'coordination is off or paused for this thread' });
      }
      const existing = this.#letters.get(source.id)?.find(letter => letter.id === params.requestId);
      if (existing) {
        if (existing.text !== params.text.trim() || existing.to.coreId !== params.to.coreId || existing.to.threadId !== params.to.threadId || existing.replyTo !== (params.replyTo ?? null)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'requestId already used for different content' });
        return structuredClone(existing);
      }
      if (!params.text.trim() || params.text.length > 4000 || this.#coordinationView(source.id).sent >= (config.mode === 'brief' ? 6 : 40)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'message size or hourly budget exceeded' });
      const destination = params.to.coreId === this.#identity.coreId ? this : FakeClient.#cores.get(params.to.coreId);
      const target = destination ? destination.#threads.get(params.to.threadId) : undefined;
      if (!target || target.archived || destination!.#coordinationConfig(target.id).mode === 'off') {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'recipient is unavailable for coordination' });
      }
      if (destination === this && target.projectId !== source.projectId && !(config.remote && this.#coordinationConfig(target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'both threads must allow coordination across projects' });
      }
      if (destination !== this && (!config.remote || !this.#peers.has(params.to.coreId) || !destination || !destination.#peers.has(this.#identity.coreId) || !destination.#coordinationConfig(target.id).remote)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'remote core is not trusted' });
      }
      const letter: AgentLetter = {
        id: params.requestId,
        from: {
          coreId: this.#identity.coreId,
          threadId: source.id,
          title: source.title,
          machine: this.#identity.name,
          resources: config.resources,
          status: source.status,
          mode: config.mode
        },
        to: params.to,
        toTitle: target?.title ?? this.#peers.get(params.to.coreId)?.name ?? params.to.threadId,
        text: params.text.trim(),
        replyTo: params.replyTo ?? null,
        createdAt: this.#now(),
        expiresAt: this.#now() + 15 * 60_000,
        status: 'delivered',
        error: null
      };
      this.#letters.set(source.id, [...(this.#letters.get(source.id) ?? []), letter]);
      this.#emit('collaboration.changed', { threadId: source.id });
      destination!.#letters.set(target.id, [...(destination!.#letters.get(target.id) ?? []), letter]);
      destination!.#emit('collaboration.changed', { threadId: target.id });
      return structuredClone(letter);
    },
    'collaboration.identity': async (params) => {
      return structuredClone(this.#identity);
    },
    'collaboration.peers': async (params) => {
      return structuredClone([...this.#peers.values()]);
    },
    'collaboration.check': async (params) => {
      const { coreId } = params;
      const peer = this.#peers.get(coreId);
      const target = FakeClient.#cores.get(coreId);
      if (!peer || !target || !target.#peers.has(this.#identity.coreId) || target.#identity.url !== peer.url) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'machine is unreachable or mutual trust is missing' });
      }
      return { ok: true };
    },
    'collaboration.trust': async (params) => {
      const { peer } = params;
      let url: URL;
      try { url = new URL(peer.url); } catch { throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer.url: expected an HTTPS or loopback URL' }); }
      const loopback = url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname);
      if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !loopback)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'peer.url: expected HTTPS origin, or numeric loopback HTTP' });
      if (!peer.coreId || !peer.publicKey || peer.coreId === this.#identity.coreId) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'peer: expected another core public identity' });
      this.#peers.set(peer.coreId, structuredClone(peer));
      return structuredClone(peer);
    },
    'collaboration.untrust': async (params) => {
      const { coreId } = params;
      this.#peers.delete(coreId);
      return { ok: true };
    },
    'speech.config': async (params) => {
      return { ...this.#speech };
    },
    'speech.status': async (params) => {
      return { ...this.#speechStatus };
    },
    'speech.configure': async (params) => {
      const p = params;
      this.#speech = { engine: p.engine, language: p.language, apiProvider: p.apiProvider, fallback: p.fallback, executable: p.executable, modelPath: p.modelPath };
      if (p.groqKey !== undefined) this.#speechStatus.groqKeySet = !!p.groqKey;
      if (p.openrouterKey !== undefined) this.#speechStatus.openrouterKeySet = !!p.openrouterKey;
      this.#speechStatus.engine = p.engine; this.#speechStatus.revision = crypto.randomUUID();
      this.#speechStatus.ready = p.engine === 'local' ? this.#speechStatus.localReady : p.apiProvider === 'groq' ? this.#speechStatus.groqKeySet : this.#speechStatus.openrouterKeySet;
      return { ...this.#speechStatus };
    },
    'speech.install': async (params) => {
      this.#speechStatus.localReady = true;
      this.#speechStatus.ready = this.#speech.engine === 'local' || this.#speechStatus.ready;
      return { ...this.#speechStatus };
    },
    'speech.installCancel': async (params) => {
      return { ...this.#speechStatus };
    },
    'speech.uninstall': async (params) => {
      this.#speechStatus.localReady = false;
      if (this.#speech.engine === 'local') this.#speechStatus.ready = false;
      return { ...this.#speechStatus };
    },
    'speech.cancel': async (params) => {
      this.#speechRequests.delete(params.requestId);
      return { ok: true };
    },
    'speech.transcribe': async (params) => {
      const p = params;
      if (!this.#speechStatus.ready) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Configure Voice first' });
      if (p.revision !== this.#speechStatus.revision) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Voice settings changed during recording; record again with the selected engine' });
      if (this.#speechRequests.size) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Another transcription is running; try again shortly' });
      const request = Symbol(p.requestId);
      this.#speechRequests.set(p.requestId, request);
      await new Promise(resolve => setTimeout(resolve, 250));
      if (this.#speechRequests.get(p.requestId) !== request) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'Transcription cancelled' });
      this.#speechRequests.delete(p.requestId);
      return { text: 'Please add a test for this change.' };
    },
    'keybindings.get': async (params) => {
      return structuredClone(this.#keybindings);
    },
    'keybindings.set': async (params) => {
      const { command, chord } = params;
      if (!(KEYBINDING_COMMANDS as readonly string[]).includes(command)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `command: "${command}" is not a command Boite has` });
      }
      if (chord !== null) {
        const parsed = parseChord(chord);
        if (!parsed.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `chord: ${parsed.reason}` });
      }
      this.#keybindings = { ...this.#keybindings, bindings: { ...this.#keybindings.bindings, [command]: chord === null ? null : chord.trim().toLowerCase() } };
      this.#emit('keybindings.updated', structuredClone(this.#keybindings));
      return structuredClone(this.#keybindings);
    },
    'keybindings.reset': async (params) => {
      const { command } = params;
      const bindings = { ...this.#keybindings.bindings };
      if (command === undefined) for (const id of KEYBINDING_COMMANDS) delete bindings[id];
      else delete bindings[command];
      this.#keybindings = { ...this.#keybindings, bindings };
      this.#emit('keybindings.updated', structuredClone(this.#keybindings));
      return structuredClone(this.#keybindings);
    },
    'settings.set': async (params) => {
      for (const field of ['maxConcurrentTurns', 'perAccountConcurrency'] as const) {
        const value = params[field];
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
          throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `${field} must be a positive integer`, data: { field } });
        }
      }
      this.#settings = { ...this.#settings, ...params };
      this.#scheduler = {
        ...this.#scheduler,
        maxConcurrentTurns: this.#settings.maxConcurrentTurns,
        perAccountConcurrency: this.#settings.perAccountConcurrency
      };
      this.#emit('scheduler.updated', structuredClone(this.#scheduler));
      this.#emit('settings.updated', { ...this.#settings });
      return { ...this.#settings };
    },
    'imports.list': async (params) => {
      if (!this.#projects.some((p) => p.id === params.projectId)) throw this.#notFound('project', params.projectId);
      await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
      // Newest first, the core's order.
      return structuredClone(
        this.#importable
          .filter((session) => session.projectId === params.projectId)
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(({ projectId: _p, ...session }) => session)
      );
    },
    'imports.run': async (params) => {
      const project = this.#projects.find((p) => p.id === params.projectId);
      if (!project) throw this.#notFound('project', params.projectId);
      const session = this.#importable.find((entry) => entry.projectId === params.projectId && entry.sessionId === params.sessionId);
      if (!session) {
        throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no transcript for session ${params.sessionId}`, data: { sessionId: params.sessionId } });
      }
      if (session.threadId !== null) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this session is already a thread', data: { sessionId: params.sessionId, threadId: session.threadId } });
      }
      await new Promise((resolve) => setTimeout(resolve, IMPORT_LIST_MS));
      const id: ThreadId = `t-${++this.#seq}`;
      const turnA: Turn = { id: `turn-${id}-1`, threadId: id, status: 'done', queuedAt: session.startedAt, startedAt: session.startedAt, finishedAt: session.startedAt + 4_000, usage: null, error: null };
      const turnB: Turn = { id: `turn-${id}-2`, threadId: id, status: 'done', queuedAt: session.updatedAt - 9_000, startedAt: session.updatedAt - 9_000, finishedAt: session.updatedAt, usage: null, error: null };
      const thread: Thread = {
        id,
        projectId: params.projectId,
        title: session.title,
        titleSource: 'agent',
        providerId: 'claude',
        accountId: params.accountId,
        model: 'claude-sonnet-5',
        effort: null,
        cwd: project.path,
        branch: null,
        permissionMode: 'default',
        status: 'idle',
        unread: false,
        archived: false,
        pinned: false,
        sessionId: session.sessionId,
        load: null,
        context: null,
        createdAt: session.startedAt,
        updatedAt: session.updatedAt,
        commands: [],
        messagesBefore: null,
        turns: [turnA, turnB],
        messages: [
          { id: `${id}-m1`, threadId: id, turnId: turnA.id, role: 'user', parts: [{ type: 'text', text: 'Where does the shell look for a core, in what order?' }], state: 'complete', createdAt: turnA.queuedAt },
          {
            id: `${id}-m2`, threadId: id, turnId: turnA.id, role: 'assistant', state: 'complete', createdAt: turnA.queuedAt + 1_000,
            parts: [
              { type: 'thinking', text: 'The order lives in the Rust side, next to the sidecar lookup.' },
              { type: 'tool', toolId: `${id}-tool-1`, name: 'Grep', input: { pattern: 'boite-core', path: 'apps/shell/src-tauri/src' }, output: 'apps/shell/src-tauri/src/core.rs:41\napps/shell/src-tauri/src/core.rs:58', status: 'done' },
              { type: 'text', text: 'Three places, in order: the sidecar beside the exe, `BOITE_CORE` in the environment, then `bun run core` from the repository.' }
            ]
          },
          { id: `${id}-m3`, threadId: id, turnId: turnB.id, role: 'user', parts: [{ type: 'text', text: 'Write that down in docs/releasing.md' }], state: 'complete', createdAt: turnB.queuedAt },
          { id: `${id}-m4`, threadId: id, turnId: turnB.id, role: 'assistant', state: 'complete', createdAt: turnB.queuedAt + 2_000, parts: [{ type: 'text', text: 'Done: a short list under "Where the shell looks for a core".' }] }
        ]
      };
      this.#threads.set(id, thread);
      session.threadId = id;
      this.#emit('thread.created', structuredClone(toSummary(thread)));
      return structuredClone(toSummary(thread));
    },
    'agent.where': async (params) => {
      const thread = this.#thread(params.threadId);
      const project = this.#projects.find((one) => one.id === thread.projectId);
      if (!project) throw this.#notFound('project', thread.projectId);
      const where: AgentWhere = {
        threadId: thread.id,
        title: thread.title,
        projectId: project.id,
        projectPath: project.path,
        cwd: thread.cwd,
        branch: thread.branch,
        // A thread of its own worktree does not sit in the project directory.
        worktree: thread.cwd !== project.path,
        providerId: thread.providerId,
        // A thread on no model of its own runs the provider's default.
        model: thread.model ?? 'default'
      };
      return where;
    },
    'panel.open': async (params) => {
      const thread = this.#thread(params.threadId);
      const surface = this.#checkSurface(thread.cwd, params.surface);
      // The core sends this to every client subscribed to the thread, and
      // `shown` says whether there was one to receive it.
      const shown = this.#subscribed.has(thread.id);
      this.#emitToThread(thread.id, 'panel.requested', {
        threadId: thread.id,
        surface,
        at: this.#now()
      });
      return { shown };
    },
    'threads.tasks.set': async (params) => {
      const thread = this.#thread(params.threadId);
      const activity: ThreadActivity = structuredClone(thread.activity ?? { goal: null, loop: null, tasks: [] });
      activity.tasks = params.tasks.map((task): AgentTask => ({ id: task.id, text: task.text, status: task.status }));
      // A fresh list is something new to look at, so a dismissal does not hold.
      activity.tasksDismissed = false;
      thread.activity = activity;
      this.#publishActivity(thread);
      return structuredClone(activity);
    },
    'threads.tasks.get': async (params) => {
      return structuredClone(this.#thread(params.threadId).activity?.tasks ?? []);
    },
    'todos.list': async (params) => {
      return this.#projectTodos(this.#thread(params.threadId).projectId);
    },
    'todos.add': async (params) => {
      const thread = this.#thread(params.threadId);
      const at = this.#now();
      const todo: Todo = {
        id: `todo-${++this.#seq}`,
        projectId: thread.projectId,
        text: todoText(params.text),
        status: 'open',
        threadId: thread.id,
        createdAt: at,
        updatedAt: at
      };
      this.#todos.push(todo);
      this.#emitTodos(thread.projectId);
      return structuredClone(todo);
    },
    'todos.update': async (params) => {
      const thread = this.#thread(params.threadId);
      const todo = this.#todos.find((one) => one.id === params.todoId && one.projectId === thread.projectId);
      if (!todo) throw this.#notFound('todo', params.todoId);
      // The status is checked before the text moves, as the core's `updateTodo`
      // builds the whole card before it saves anything.
      if (params.status !== undefined && !TODO_STATUSES.includes(params.status)) {
        throw refusal(`a todo is ${TODO_STATUSES.join(', ')}, not ${String(params.status)}`);
      }
      if (params.text !== undefined) todo.text = todoText(params.text);
      if (params.status !== undefined) todo.status = params.status;
      todo.threadId = thread.id;
      todo.updatedAt = this.#now();
      this.#emitTodos(thread.projectId);
      return structuredClone(todo);
    },
    'todos.remove': async (params) => {
      const thread = this.#thread(params.threadId);
      const index = this.#todos.findIndex((one) => one.id === params.todoId && one.projectId === thread.projectId);
      if (index < 0) throw this.#notFound('todo', params.todoId);
      this.#todos.splice(index, 1);
      this.#emitTodos(thread.projectId);
      return { ok: true as const };
    },
    'git.status': async (params) => {
      const thread = this.#thread(params.threadId);
      const branch = thread.branch ?? 'main';
      const status: GitStatus = {
        branch,
        upstream: `origin/${branch}`,
        ahead: 2,
        behind: 1,
        changes: structuredClone(FAKE_CHANGES)
      };
      return status;
    },
    'git.diff': async (params) => {
      const path = this.#inside(this.#thread(params.threadId).cwd, params.path, 'git.diff path');
      const change = FAKE_CHANGES.find((one) => one.path === path);
      if (!change) throw this.#notFound('change', path);
      const sides = FAKE_DIFFS[path] ?? {
        // A row with no fixture of its own still opens on two readable sides.
        oldText: `// ${path}
const ready = false;
`,
        newText: `// ${path}
const ready = true;
`,
        binary: false,
        truncated: false
      };
      const diff: GitDiff = { path: change.path, oldPath: change.oldPath, status: change.status, ...sides };
      return diff;
    },
    'files.list': async (params) => {
      const cwd = this.#thread(params.threadId).cwd;
      return this.#listDir(this.#inside(cwd, params.path ?? '', 'files.list path', 'dir'));
    },
    'files.read': async (params) => {
      const path = this.#inside(this.#thread(params.threadId).cwd, params.path, 'files.read path', 'file');
      // A picture, a sound and anything else binary answer as a url, the way
      // the core hands out a ticket, except that these carry their own bytes.
      const media = FAKE_MEDIA[path];
      if (media) {
        const url = media.url();
        const blob: FileContent = {
          kind: media.kind,
          path,
          bytes: fakeBytes(path, undefined),
          modifiedAt: this.#fileTime(path),
          mime: media.mime,
          url
        };
        return blob;
      }
      const text = this.#files.get(path) ?? '';
      const content: FileContent = {
        kind: 'text',
        path,
        bytes: text.length,
        modifiedAt: this.#fileTime(path),
        text,
        truncated: false,
        language: fakeLanguage(path)
      };
      return content;
    },
    'files.write': async (params) => {
      const cwd = this.#thread(params.threadId).cwd;
      const path = this.#inside(cwd, params.path, 'files.write path');
      // The file may be new, its directory may not, and what is there already has to be a file.
      this.#inside(cwd, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', 'files.write path directory', 'dir');
      if (this.#isDir(path)) throw refusal(`files.write path is not a file: ${params.path}`);
      if (FAKE_MEDIA[path]) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this file is not text' });
      }
      this.#files.set(path, params.text);
      return { bytes: params.text.length, modifiedAt: this.#now() };
    },
  };

  #coordinationConfig(threadId: ThreadId): CoordinationConfig {
    return this.#coordination.get(threadId) ?? { mode: 'off', resources: '', remote: false, paused: false };
  }

  #coordinationView(threadId: ThreadId): CoordinationView {
    const config = this.#coordinationConfig(threadId);
    const letters = this.#letters.get(threadId) ?? [];
    const sendLimit = config.mode === 'brief' ? 6 : config.mode === 'team' ? 40 : 0;
    const wakeLimit = config.mode === 'brief' ? 2 : config.mode === 'team' ? 12 : 0;
    return {
      self: { coreId: this.#identity.coreId, threadId },
      config: structuredClone(config),
      messages: structuredClone(letters),
      sent: letters.filter(letter => letter.from.coreId === this.#identity.coreId && letter.from.threadId === threadId && letter.createdAt > this.#now() - 3_600_000).length,
      sendLimit,
      wakes: 0,
      wakeLimit
    };
  }

  #quotas(): AccountQuota[] {
    const accounts = [...this.#accounts, { id: 'quota:antigravity-cli', providerId: 'antigravity', label: 'Antigravity CLI' }];
    return accounts.map((account, index) => ({
      accountId: account.id, providerId: account.providerId, providerName: account.providerId === 'opencode' ? 'OpenCode Go' : this.#providers.find((p) => p.id === account.providerId)?.name ?? account.providerId,
      label: account.label, enabled: account.id === 'quota:antigravity-cli' ? this.#quotaEnabled[account.id] === true : this.#quotaEnabled[account.id] !== false,
      status: account.providerId === 'echo' || account.providerId === 'pi' || account.id === 'a-antigravity' ? 'unsupported' : this.#quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && this.#quotaEnabled[account.id] !== true ? 'disabled' : 'ready',
      checkedAt: Date.now(), error: null,
      windows: this.#quotaEnabled[account.id] === false || account.id === 'quota:antigravity-cli' && this.#quotaEnabled[account.id] !== true ? [] : [
        { id: 'primary', label: '5 hours', usedPercent: [32, 87, 14, 48, 71, 6, 23, 40][index % 8]!, resetsAt: Date.now() + (1 + index % 4) * 3600_000 },
        { id: 'secondary', label: 'Weekly', usedPercent: [61, 94, 38, 27, 55, 12, 73, 66][index % 8]!, resetsAt: Date.now() + (1 + index % 6) * 86400_000 },
      ],
    }));
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async #stopTurn(threadId: ThreadId): Promise<boolean> {
    this.#pauseActivity(this.#thread(threadId));
    const running = this.#inFlight.get(threadId);
    let stopped = running !== undefined;
    if (running) running.cancelled = true;
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.request.threadId !== threadId) continue;
      stopped = true;
      this.#pendingPermissions.delete(requestId);
      pending.resolve('deny');
    }
    for (const [questionId, pending] of [...this.#pendingQuestions]) {
      if (pending.request.threadId !== threadId) continue;
      stopped = true;
      this.#pendingQuestions.delete(questionId);
      pending.resolve(null);
    }
    await running?.done;
    return stopped;
  }

  #startTurn(threadId: ThreadId, prompt: string, attachments: Attachment[] = [], operation?: 'compact', activityKind?: 'goal' | 'loop'): Turn {
    const thread = this.#thread(threadId);
    if (thread.archived) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot start a turn on an archived thread', data: { threadId } });
    }
    if (['queued', 'running', 'waiting'].includes(thread.status) || this.#inFlight.has(threadId)) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn', data: { threadId } });
    }
    // The agent names what it takes on its first turn, the way the echo driver
    // does: the list is the agent's, so it only exists once one has run.
    if (thread.commands.length === 0) {
      thread.commands = structuredClone(ECHO_COMMANDS);
      this.#emitToThread(threadId, 'thread.commands', {
        threadId,
        commands: structuredClone(thread.commands)
      });
    }

    const at = this.#now();
    const turn: Turn = {
      id: `turn-${++this.#seq}`,
      threadId,
      status: 'running',
      queuedAt: at,
      startedAt: at,
      finishedAt: null,
      usage: null,
      error: null,
      execution: {
        providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
        effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode, sessionId: thread.sessionId,
        sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
        ...(operation ? { operation } : {}),
      }
    };
    thread.turns.push(turn);

    const user: Message = {
      id: `m-${++this.#seq}`,
      threadId,
      turnId: turn.id,
      role: 'user',
      // The images ride after the text, the order the core journals them in.
      parts: [
        { type: 'text', text: activityKind ? `/${activityKind} ${prompt}` : prompt, ...(activityKind ? { activity: { kind: activityKind, iteration: (thread.activity?.[activityKind]?.iterations ?? 0) + 1 } } : {}) },
        ...attachments.map((attachment): MessagePart => attachment.kind === 'file' ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name } : ({
          type: 'image',
          mimeType: attachment.mimeType,
          data: attachment.data,
          alt: attachment.name
        }))
      ],
      state: 'complete',
      createdAt: at
    };
    if (!activityKind && !operation && thread.activity) {
      if (thread.activity.tasks.length && thread.activity.tasks.every(task => task.status === 'completed')) thread.activity.tasksDismissed = true;
      if (thread.activity.goal?.status === 'complete') thread.activity.goal.dismissed = true;
      this.#publishActivity(thread);
    }
    thread.messages.push(user);
    this.#emitToThread(threadId, 'message.started', structuredClone(user));
    this.#emitToThread(threadId, 'message.completed', {
      threadId,
      messageId: user.id,
      state: 'complete'
    });

    thread.status = 'running';
    thread.sessionId = thread.sessionId ?? `sess-${turn.id}`;
    this.#touch(thread);
    this.#emit('turn.started', structuredClone(turn));
    this.#pushScheduler(turn, 'running');

    const record = { cancelled: false, done: Promise.resolve() };
    record.done = this.#stream(thread, turn, prompt, record, attachments);
    this.#inFlight.set(threadId, record);

    return structuredClone(turn);
  }

  async #stream(
    thread: Thread,
    turn: Turn,
    prompt: string,
    record: { cancelled: boolean },
    attachments: Attachment[] = []
  ): Promise<void> {
    const compactAfter = Math.max(1, Math.floor((thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) / 4));
    const message: Message = {
      id: `m-${++this.#seq}`,
      threadId: thread.id,
      turnId: turn.id,
      role: 'assistant',
      parts: [{ type: 'thinking', text: '' }],
      state: 'streaming',
      createdAt: this.#now()
    };
    thread.messages.push(message);
    this.#emitToThread(thread.id, 'message.started', structuredClone(message));

    // The reasoning first, in two deltas, the way a provider streams a thinking block.
    const reasoning = `thinking about: ${prompt}`;
    const cut = Math.ceil(reasoning.length / 2);
    for (const piece of [reasoning.slice(0, cut), reasoning.slice(cut)]) {
      if (record.cancelled || piece.length === 0) break;
      await this.#pause();
      const part = message.parts[0];
      if (part && part.type === 'thinking') part.text += piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex: 0,
        text: piece
      });
    }

    const textIndex = message.parts.length;
    message.parts.push({ type: 'text', text: '' });
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex: textIndex,
      part: { type: 'text', text: '' }
    });

    // `/shout <text>` comes back in capitals, the one command the fake acts on.
    const shouted = prompt.startsWith(`/${SHOUT} `) ? prompt.slice(SHOUT.length + 2) : null;
    const echoed = shouted === null ? prompt : shouted.toUpperCase();

    // An image is named back the way the echo driver names it, format and
    // weight first, then the prompt itself is echoed.
    const reply =
      attachments
        .map(
          (attachment) =>
            `[${attachment.kind} ${attachment.mimeType}, ${decodedBytes(attachment.data)} bytes${attachment.name === null ? '' : `, ${attachment.name}`
            }] `
        )
        .join('') + echoed;

    for (const piece of chunkText(reply, 5)) {
      if (record.cancelled) break;
      await this.#pause();
      const part = message.parts[textIndex];
      if (part && part.type === 'text') part.text += piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex: textIndex,
        text: piece
      });
    }

    if (!record.cancelled && prompt.includes('[permission]')) {
      await this.#askPermission(thread, turn, message);
    }
    // The bare word, like the echo driver: the fake agent asks one question.
    if (!record.cancelled && /\bquestion\b/.test(prompt)) {
      await this.#askQuestion(thread, turn, message);
    }
    if (!record.cancelled && prompt.includes('[tool-stream]')) {
      await this.#streamToolInput(thread, message);
    }
    if (!record.cancelled && prompt.includes('[tool]')) {
      await this.#runTool(thread, message);
    }
    if (!record.cancelled && prompt.includes('[diff]')) {
      await this.#documentTool(thread, message, 'Edit', { file_path: DIFF_PATH }, 'edited 1 file', [
        { kind: 'diff', path: DIFF_PATH, oldText: DIFF_OLD, newText: DIFF_NEW }
      ]);
    }
    if (!record.cancelled && prompt.includes('[doc]')) {
      await this.#documentTool(thread, message, 'Read', { file_path: DOC_TITLE }, `read ${DOC_TITLE}`, [
        { kind: 'markdown', title: DOC_TITLE, text: DOC_TEXT }
      ]);
    }
    if (!record.cancelled && prompt.includes('[image]')) {
      await this.#documentTool(thread, message, 'Screenshot', { region: 'window' }, 'captured the window', [
        { kind: 'image', mimeType: 'image/png', data: IMAGE_BASE64, alt: 'one pixel' }
      ]);
    }
    const spawn = SPAWN_MARKER.exec(prompt);
    if (!record.cancelled && spawn && spawn[1]) {
      await this.#spawnProcess(thread, spawn[1]);
    }

    if (!record.cancelled && prompt === '[compact]') {
      const part: MessagePart = { type: 'compaction', trigger: 'manual', preTokens: thread.context?.tokens ?? null, postTokens: compactAfter };
      const partIndex = message.parts.length;
      message.parts.push(part);
      this.#emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part });
    }
    message.state = 'complete';
    this.#emitToThread(thread.id, 'message.completed', {
      threadId: thread.id,
      messageId: message.id,
      state: 'complete'
    });

    const usage: Usage = {
      inputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      outputTokens: Math.max(1, Math.ceil(prompt.length / 4)),
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEquivalent: Math.round(prompt.length * 0.02) / 1000
    };
    turn.status = record.cancelled ? 'stopped' : 'done';
    turn.finishedAt = this.#now();
    turn.usage = usage;
    this.#usage.set(thread.id, addUsage(this.#usage.get(thread.id) ?? emptyUsage(), usage));
    this.#finished.push({ at: turn.finishedAt, threadId: thread.id, title: thread.title, projectId: thread.projectId, providerId: thread.providerId, model: thread.model, usage });

    this.#inFlight.delete(thread.id);
    thread.status = 'idle';
    thread.unread = !this.#subscribed.has(thread.id);
    // The context meter grows with every turn, the way a real session's does.
    thread.context = {
      tokens: prompt === '[compact]' && !record.cancelled ? compactAfter : (thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) + FAKE_CONTEXT_PER_TURN + prompt.length * 4,
      window: FAKE_CONTEXT_WINDOW,
      at: this.#now()
    };
    this.#touch(thread);
    this.#emit('turn.finished', structuredClone(turn));
    this.#pushScheduler(turn, 'finished');
  }

  async #askPermission(thread: Thread, turn: Turn, message: Message): Promise<void> {
    const requestId = `req-${++this.#seq}`;
    const partIndex = message.parts.length;
    const part: MessagePart = {
      type: 'permission',
      requestId,
      toolName: 'Write',
      decision: null
    };
    message.parts.push(part);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(part)
    });

    const request: PermissionRequest = {
      id: requestId,
      threadId: thread.id,
      turnId: turn.id,
      toolName: 'Write',
      input: { path: `${thread.cwd}\\notes.md`, contents: 'the thing you asked for' },
      description: 'Write a file inside the working directory',
      createdAt: this.#now()
    };
    thread.status = 'waiting';
    this.#touch(thread);
    this.#emit('permission.requested', structuredClone(request));

    const decision = await new Promise<'allow' | 'deny'>((resolve) => {
      this.#pendingPermissions.set(requestId, { request, resolve });
    });

    this.#settlePermission(thread, message, partIndex, request, decision);
    thread.status = 'running';
    this.#touch(thread);
  }

  async #askQuestion(thread: Thread, turn: Turn, message: Message): Promise<void> {
    const questionId = `qst-${++this.#seq}`;
    const partIndex = message.parts.length;
    const asked = {
      text: QUESTION_TEXT,
      options: QUESTION_OPTIONS,
      allowText: true,
      multiple: false
    };
    const part: MessagePart = { type: 'question', questionId, ...asked, answer: null };
    message.parts.push(part);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(part)
    });

    const request: QuestionRequest = {
      id: questionId,
      threadId: thread.id,
      turnId: turn.id,
      ...asked,
      createdAt: this.#now()
    };
    thread.status = 'waiting';
    this.#touch(thread);
    this.#emit('question.asked', structuredClone(request));

    const answer = await new Promise<QuestionAnswer | null>((resolve) => {
      this.#pendingQuestions.set(questionId, { request, resolve });
    });

    this.#settleQuestion(thread, message, partIndex, request, answer);
    thread.status = 'running';
    this.#touch(thread);
  }

  /** The answer written into the part, then the event, whichever path answered. */
  #settleQuestion(
    thread: Thread,
    message: Message,
    partIndex: number,
    request: QuestionRequest,
    answer: QuestionAnswer | null
  ): void {
    const stored = message.parts[partIndex];
    if (stored && stored.type === 'question') stored.answer = answer;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: {
        type: 'question',
        questionId: request.id,
        text: request.text,
        options: request.options,
        allowText: request.allowText,
        multiple: request.multiple,
        answer
      }
    });
    this.#emit('question.answered', { questionId: request.id, threadId: thread.id, answer });
  }

  /** Writes the answer into the part and tells everyone, whichever path asked. */
  #settlePermission(
    thread: Thread,
    message: Message,
    partIndex: number,
    request: PermissionRequest,
    decision: 'allow' | 'deny'
  ): void {
    const stored = message.parts[partIndex];
    if (stored && stored.type === 'permission') stored.decision = decision;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: { type: 'permission', requestId: request.id, toolName: request.toolName, decision }
    });
    this.#emit('permission.resolved', { requestId: request.id, threadId: thread.id, decision });
  }

  /**
   * A tool whose input the model is still typing: the part opens with no input
   * and an empty `inputText`, the JSON arrives as deltas, then the parsed input
   * replaces it. The same shape the Claude driver's `input_json_delta` produces.
   */
  async #streamToolInput(thread: Thread, message: Message): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const opening: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Bash',
      input: {},
      inputText: '',
      output: null,
      status: 'running'
    };
    message.parts.push(opening);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(opening)
    });

    for (const piece of chunkText(STREAMED_TOOL_INPUT, 4)) {
      await this.#pause();
      const part = message.parts[partIndex];
      if (part && part.type === 'tool') part.inputText = (part.inputText ?? '') + piece;
      this.#emitToThread(thread.id, 'message.delta', {
        threadId: thread.id,
        messageId: message.id,
        partIndex,
        text: piece
      });
    }

    await this.#pause();
    const done: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Bash',
      input: JSON.parse(STREAMED_TOOL_INPUT) as unknown,
      inputText: null,
      output: 'streamed',
      status: 'done'
    };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  /** One tool that lands whole, carrying the documents it produced. */
  async #documentTool(
    thread: Thread,
    message: Message,
    name: string,
    input: unknown,
    output: string,
    documents: ToolDocument[]
  ): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const running: MessagePart = {
      type: 'tool',
      toolId,
      name,
      input,
      output: null,
      status: 'running',
      documents
    };
    message.parts.push(running);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(running)
    });

    await this.#pause();

    const done: MessagePart = { ...running, output, status: 'done' };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  async #runTool(thread: Thread, message: Message): Promise<void> {
    const partIndex = message.parts.length;
    const toolId = `tool-${++this.#seq}`;
    const input = { pattern: 'registerMethods', path: thread.cwd };
    const running: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Grep',
      input,
      output: null,
      status: 'running'
    };
    message.parts.push(running);
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(running)
    });

    await this.#pause();

    const done: MessagePart = {
      type: 'tool',
      toolId,
      name: 'Grep',
      input,
      output: 'packages/core/src/modules.ts:12\npackages/core/src/server.ts:44',
      status: 'done'
    };
    message.parts[partIndex] = done;
    this.#emitToThread(thread.id, 'message.part', {
      threadId: thread.id,
      messageId: message.id,
      partIndex,
      part: structuredClone(done)
    });
  }

  async #spawnProcess(thread: Thread, exe: string): Promise<void> {
    const pid = 10_000 + ++this.#seq;
    const record: ProcessRecord = {
      pid,
      parentPid: this.#core.pid,
      threadId: thread.id,
      exe,
      commandLine: `${exe} --from boite`,
      startedAt: this.#now(),
      exitedAt: null,
      exitCode: null,
      cpuMs: null,
      peakMemoryBytes: null,
      ioBytes: null
    };
    this.#processes.push(record);
    thread.load = { processes: 1, cpuPercent: 12, memoryBytes: 48 * 1024 * 1024 };
    this.#touch(thread);
    this.#emit('process.started', structuredClone(record));

    await this.#pause();

    record.exitedAt = this.#now();
    record.exitCode = 0;
    record.cpuMs = 120;
    record.peakMemoryBytes = 48 * 1024 * 1024;
    record.ioBytes = 32 * 1024;
    thread.load = null;
    this.#touch(thread);
    this.#emit('process.exited', structuredClone(record));
  }

  // -------------------------------------------------------------------------
  // Account login
  // -------------------------------------------------------------------------

  #loginEvent(event: RpcEvents['account.login']): void {
    if (event.state === 'running') {
      const existing = this.#logins.get(event.accountId);
      this.#logins.set(event.accountId, existing ? Object.assign(existing, event) : event);
    } else this.#logins.delete(event.accountId);
    this.#emit('account.login', structuredClone(event));
  }

  #cancelLogin(accountId: string): void {
    if (!this.#logins.has(accountId)) return;
    this.#loginEvent({ accountId, state: 'done', output: 'Login cancelled', url: null, exitCode: null });
  }

  /** What a provider CLI prints first: a link to open, then a question. */
  async #fakeLoginPrompt(accountId: string): Promise<void> {
    const active = this.#logins.get(accountId);
    await this.#pause();
    if (!active || this.#logins.get(accountId) !== active) return;
    this.#loginEvent({
      accountId,
      state: 'running',
      output: 'Open https://example.invalid/login?code=fake to continue',
      url: 'https://example.invalid/login?code=fake',
      exitCode: null
    });
  }

  async #finishFakeLogin(account: Account): Promise<void> {
    const active = this.#logins.get(account.id);
    await this.#pause();
    if (!active || this.#logins.get(account.id) !== active) return;
    this.#loginEvent({
      accountId: account.id,
      state: 'done',
      output: 'logged in',
      url: 'https://example.invalid/login?code=fake',
      exitCode: 0
    });
    account.status = 'ok';
    account.identity = 'you@example.com';
    this.#emit('accounts.updated', structuredClone(account));
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  #now(): number {
    return T0 + this.#seq * 1000;
  }

  #tick(): Promise<void> {
    return Promise.resolve();
  }

  #pause(): Promise<void> {
    if (this.#delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.#delayMs));
  }

  #setState(state: ClientState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const handler of this.#stateHandlers) handler(state);
  }

  /**
   * One call the socket holds. A reply that lands after `drop()` broke the
   * promise is thrown away rather than settling it twice, which is what
   * `WsClient` gets for free by clearing `#pending` before it rejects.
   */
  #hold<T>(answer: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = { reject };
      this.#pending.add(entry);
      answer.then(
        (value) => {
          if (this.#pending.delete(entry)) resolve(value);
        },
        (error: unknown) => {
          if (this.#pending.delete(entry)) reject(error);
        }
      );
    });
  }

  #dropPending(message: string): void {
    this.#speechRequests.clear();
    const pending = [...this.#pending];
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(new RpcFailure({ code: RpcErrorCode.Internal, message }));
    }
  }

  #publishActivity(thread: Thread): void {
    this.#emit('thread.activity', { threadId: thread.id, activity: structuredClone(thread.activity!) });
  }

  #pauseActivity(thread: Thread): void {
    const timer = this.#activityTimers.get(thread.id);
    if (timer) clearTimeout(timer);
    this.#activityTimers.delete(thread.id);
    if (!thread.activity) return;
    for (const kind of ['goal', 'loop'] as const) {
      const item = thread.activity[kind];
      if (item?.status === 'active') item.status = 'paused';
    }
    if (thread.activity.loop) thread.activity.loop.nextRunAt = null;
    this.#publishActivity(thread);
  }

  #scheduleActivity(threadId: string, delay = 0): void {
    const old = this.#activityTimers.get(threadId);
    if (old) clearTimeout(old);
    this.#activityTimers.delete(threadId);
    const thread = this.#threads.get(threadId);
    const activity = thread?.activity;
    if (!thread || thread.archived || !activity || (activity.goal?.status !== 'active' && activity.loop?.status !== 'active')) return;
    this.#activityTimers.set(threadId, setTimeout(() => {
      this.#activityTimers.delete(threadId);
      if (this.#inFlight.has(threadId) || ['running', 'queued', 'waiting'].includes(thread.status)) return;
      const kind = activity.loop?.status === 'active' && (activity.loop.nextRunAt ?? 0) <= Date.now() ? 'loop' : activity.goal?.status === 'active' ? 'goal' : null;
      if (!kind) {
        if (activity.loop?.status === 'active') this.#scheduleActivity(threadId, Math.max(0, (activity.loop.nextRunAt ?? Date.now()) - Date.now()));
        return;
      }
      try {
        const turn = this.#startTurn(threadId, kind === 'goal' ? activity.goal!.objective : activity.loop!.prompt, [], undefined, kind);
        this.#activityTurns.set(turn.id, { kind, generation: this.#activityGenerations.get(`${threadId}:${kind}`) ?? 0 });
        activity[kind]!.iterations++;
        if (kind === 'loop') {
          activity.loop!.nextRunAt = null;
          activity.loop!.history = [...(activity.loop!.history ?? []), { iteration: activity.loop!.iterations, turnId: turn.id, status: 'running' as const, summary: '', startedAt: Date.now(), finishedAt: null }].slice(-50);
        }
        this.#publishActivity(thread);
      } catch (error) {
        this.#pauseActivity(thread);
        activity[kind]!.error = error instanceof Error ? error.message : String(error);
        this.#publishActivity(thread);
      }
    }, delay));
  }

  #emit<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
    if (event === 'turn.finished') {
      const turn = payload as Turn;
      const owned = this.#activityTurns.get(turn.id);
      this.#activityTurns.delete(turn.id);
      const thread = this.#threads.get(turn.threadId);
      const current = owned && owned.generation === (this.#activityGenerations.get(`${turn.threadId}:${owned.kind}`) ?? 0);
      if (thread?.activity) {
        if (owned?.kind === 'loop' && current && thread.activity.loop) {
          const loop = thread.activity.loop;
          const run = loop.history?.find(run => run.turnId === turn.id);
          if (run) {
            run.status = turn.status === 'done' ? 'done' : turn.status === 'stopped' ? 'stopped' : 'error';
            run.finishedAt = turn.finishedAt ?? Date.now();
            run.summary = thread.messages.filter(message => message.turnId === turn.id && message.role === 'assistant').flatMap(message => message.parts.filter(part => part.type === 'text').map(part => part.text)).join('\n').slice(0, 4000);
          }
          if (turn.status === 'done' && loop.maxIterations && loop.iterations >= loop.maxIterations) { loop.status = 'complete'; loop.nextRunAt = null; }
          else if (loop.status === 'active') loop.nextRunAt = Date.now() + loop.intervalMs;
          this.#publishActivity(thread);
        }
        if (turn.status !== 'done' && (!owned || current)) this.#pauseActivity(thread);
        else {
          // The in-memory agent completes its fake goal after one echo turn.
          if (owned?.kind === 'goal' && current && thread.activity.goal?.status === 'active') { thread.activity.goal.status = 'complete'; this.#publishActivity(thread); }
          this.#scheduleActivity(thread.id, 250);
        }
      }
    }
    // A socket that is down carries nothing. Everything the core emitted
    // during the gap is lost, which is what `reload()` exists to repair.
    if (this.#state !== 'ready') return;
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) handler(payload);
  }

  #emitToThread<E extends RpcEventName>(threadId: ThreadId, event: E, payload: RpcEvents[E]): void {
    if (!this.#subscribed.has(threadId)) return;
    this.#emit(event, payload);
  }

  #thread(threadId: ThreadId): Thread {
    const thread = this.#threads.get(threadId);
    if (!thread) throw this.#notFound('thread', threadId);
    return thread;
  }

  /**
   * The `limit` messages that sit just before `end`, oldest first, with the
   * cursor for what is still behind them. The core reads the same window off
   * rowids; here it is a slice of the array the fake keeps.
   */
  #page(
    messages: Message[],
    end: number,
    limit: number
  ): { messages: Message[]; before: MessageId | null } {
    const start = Math.max(0, end - limit);
    const page = messages.slice(start, end);
    return { messages: page, before: start > 0 ? (page[0]?.id ?? null) : null };
  }

  /** The project's cards, the ones already done last, the core's order. */
  #projectTodos(projectId: string): Todo[] {
    const rank = (todo: Todo): number => (todo.status === 'done' ? 1 : 0);
    return structuredClone(
      this.#todos
        .filter((todo) => todo.projectId === projectId)
        .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt)
    );
  }

  /** A list is shared by the project, so the whole of it travels on every change. */
  #emitTodos(projectId: string): void {
    this.#emit('todos.updated', { projectId, todos: this.#projectTodos(projectId) });
  }

  /** A stable time per path, so two runs of a capture read the same tree. */
  #fileTime(path: string): number {
    const index = [...this.#files.keys(), ...FAKE_MEDIA_PATHS].indexOf(path);
    return T0 - Math.max(0, index) * 3_600_000;
  }

  /** One directory of the fixture tree, directories first, then files by name. */
  #listDir(path: string): FileEntry[] {
    const prefix = path === '' ? '' : `${path.replace(/[\\/]+$/, '')}/`;
    const dirs = new Set<string>();
    const files: FileEntry[] = [];
    for (const full of [...this.#files.keys(), ...FAKE_MEDIA_PATHS]) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const cut = rest.indexOf('/');
      if (cut >= 0) {
        dirs.add(rest.slice(0, cut));
        continue;
      }
      files.push({
        name: rest,
        path: full,
        kind: 'file',
        bytes: fakeBytes(full, this.#files.get(full)),
        modifiedAt: this.#fileTime(full)
      });
    }
    const byName = (a: FileEntry, b: FileEntry): number => a.name.localeCompare(b.name);
    return [
      ...[...dirs]
        .map((name): FileEntry => ({ name, path: `${prefix}${name}`, kind: 'dir', bytes: null, modifiedAt: T0 }))
        .sort(byName),
      ...files.sort(byName)
    ];
  }

  #isDir(path: string): boolean {
    if (path === '') return true;
    const prefix = `${path}/`;
    return [...this.#files.keys(), ...FAKE_MEDIA_PATHS].some((full) => full.startsWith(prefix));
  }

  /**
   * The core's `resolveInside`, and `existingInside` when `expect` is given,
   * over the fake tree: a path relative to the thread's directory or absolute
   * inside it, never out of it, answered in the relative form with forward
   * slashes the core answers with.
   */
  #inside(cwd: string, path: unknown, what: string, expect?: 'file' | 'dir'): string {
    if (typeof path !== 'string') throw refusal(`${what} must be a path, got ${typeof path}`);
    const root = cwd.replace(/[\\/]+$/, '').replace(/\\/g, '/');
    let rest = path.replace(/\\/g, '/');
    if (/^([a-z]:)?\//i.test(rest)) {
      if (rest.toLowerCase() !== root.toLowerCase() && !rest.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        throw refusal(`${what} leaves the thread's working directory: ${path}`);
      }
      rest = rest.slice(root.length);
    }
    const parts: string[] = [];
    for (const part of rest.split('/')) {
      if (part === '' || part === '.') continue;
      if (part !== '..') parts.push(part);
      else if (parts.pop() === undefined) throw refusal(`${what} leaves the thread's working directory: ${path}`);
    }
    const relative = parts.join('/');
    if (expect === undefined) return relative;
    const isFile = this.#files.has(relative) || FAKE_MEDIA[relative] !== undefined;
    const isDir = this.#isDir(relative);
    if (!isFile && !isDir) throw refusal(`${what} does not exist: ${path}`);
    if (expect === 'file' && !isFile) throw refusal(`${what} is not a file: ${path}`);
    if (expect === 'dir' && !isDir) throw refusal(`${what} is not a directory: ${path}`);
    return relative;
  }

  /**
   * The core's `checkSurface` in `agent.ts`: a file that is there, a directory
   * that is, a diff path inside the directory, an http or https url, and the
   * relative path every client compares tabs by.
   */
  #checkSurface(cwd: string, surface: PanelSurface): PanelSurface {
    const kind = (surface as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== 'string' || !(PANEL_SURFACE_KINDS as readonly string[]).includes(kind)) {
      throw refusal(`panel.open does not know the surface ${String(kind)}`);
    }
    const path = (surface as { path?: unknown }).path;
    if (kind === 'file') {
      if (typeof path !== 'string' || path.length === 0) throw refusal('panel.open file needs a path');
      const found = this.#inside(cwd, path, 'panel.open file path', 'file');
      const line = (surface as { line?: unknown }).line;
      if (line === undefined || line === null) return { kind, path: found };
      if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
        throw refusal(`panel.open line must be a line number, got ${String(line)}`);
      }
      return { kind, path: found, line };
    }
    if (kind === 'files') {
      if (path === undefined || path === null) return { kind };
      return { kind, path: this.#inside(cwd, path, 'panel.open files path', 'dir') };
    }
    if (kind === 'diff') {
      // A diff names a file that may be gone from the working tree.
      if (path === undefined || path === null) return { kind };
      return { kind, path: this.#inside(cwd, path, 'panel.open diff path') };
    }
    if (kind === 'browser') {
      const url = (surface as { url?: unknown }).url;
      let parsed: URL;
      try {
        parsed = new URL(String(url));
      } catch {
        throw refusal(`panel.open browser needs a url, got ${String(url)}`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw refusal(`panel.open browser takes http or https, not ${parsed.protocol.replace(':', '')}`);
      }
      return { kind, url: parsed.href };
    }
    return { kind: kind as 'trace' | 'tasks' };
  }

  #notFound(what: string, id: string): RpcFailure {
    return new RpcFailure({
      code: RpcErrorCode.NotFound,
      message: `no such ${what}: ${id}`,
      data: { id }
    });
  }

  #touch(thread: Thread): ThreadSummary {
    thread.updatedAt = this.#now();
    const summary = structuredClone(toSummary(thread));
    this.#emit('thread.updated', summary);
    return structuredClone(summary);
  }

  #pushScheduler(turn: Turn, phase: 'running' | 'finished'): void {
    if (phase === 'running') {
      this.#scheduler.running = [
        ...this.#scheduler.running,
        { turnId: turn.id, threadId: turn.threadId, startedAt: turn.startedAt ?? this.#now() }
      ];
    } else {
      this.#scheduler.running = this.#scheduler.running.filter((r) => r.turnId !== turn.id);
    }
    this.#emit('scheduler.updated', structuredClone(this.#scheduler));
  }

  /**
   * ACP, Codex and pi probe their own catalogs. Demo models are explicitly
   * named as such; only OpenCode uses the large catalog fixture.
   */
  #checkSpeed(providerId: string, accountId: string, model: string | null, speed: string | null): void {
    if (speed === null) return;
    const models = this.#modelCatalogs.get(providerId + '::' + accountId) ?? this.#providers.find(p => p.id === providerId)?.models ?? [];
    if (!models.find(m => m.id === model)?.speeds?.some(option => option.id === speed)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model does not offer this speed' });
  }

  async #probe(providerId: string, accountId: string): Promise<RpcResult<'providers.probe'>> {
    const provider = this.#providers.find((p) => p.id === providerId);
    if (!provider) {
      throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown provider ${providerId}` });
    }
    const account = this.#accounts.find((a) => a.id === accountId);
    if (!account) throw this.#notFound('account', accountId);
    if (account.providerId !== providerId) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the account belongs to another provider' });
    }
    const dynamic = ['acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol);
    if (dynamic && !provider.available) {
      throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${provider.name} is not available on this machine` });
    }
    let models = structuredClone(provider.models);
    if (dynamic) {
      models = provider.id === UPDATABLE_ID ? structuredClone(PROBED_MODELS) : [
        ...models,
        { id: `${provider.id}-demo`, name: `${provider.name} demo model`, default: false, ...(provider.protocol === 'codex-appserver' ? { effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: 'high' }, speeds: [{ id: 'fast', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }] } : provider.protocol === 'muse' ? { effort: MUSE_EFFORT } : {}) }
      ];
      await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
    }
    this.#modelCatalogs.set(providerId + '::' + accountId, models);
    const probedAt = this.#now();
    this.#emit('providers.probed', { providerId, accountId, models: structuredClone(models), probedAt });
    return { models, probedAt };
  }

  // -------------------------------------------------------------------------
  // Agent updates
  // -------------------------------------------------------------------------

  /**
   * Two agents behind their newest release, one by each route, so the notices
   * have a subject. The fake page shows them on `?updates=1` only: a card
   * pinned to a corner would sit in every other capture.
   */
  #harnessUpdates: HarnessUpdate[] = ([
    { providerId: 'claude', name: 'Claude Code', route: 'self', current: '2.1.267', latest: '2.1.278', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'codex', name: 'Codex', route: 'managed', current: '0.154.0', latest: '0.155.1', pending: true, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    { providerId: 'opencode', name: 'OpenCode', route: 'self', current: '1.18.31', latest: '1.18.31', pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() },
    // No way to name its newest release: the row that offers the updater itself.
    { providerId: 'antigravity', name: 'Antigravity', route: 'self', current: '1.2.7', latest: null, pending: false, skipped: null, state: 'idle', message: null, checkedAt: Date.now() }
  ] satisfies HarnessUpdate[]).map((update) => (quietUpdates() ? { ...update, current: update.latest ?? update.current, pending: false } : update));

  #harnessUpdate(providerId: string): HarnessUpdate {
    const update = this.#harnessUpdates.find((entry) => entry.providerId === providerId);
    if (!update) throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${providerId} has no update Boite can run on this machine` });
    return update;
  }

  #updateHarness(providerId: string): RpcResult<'providers.update'> {
    const update = this.#harnessUpdate(providerId);
    if (update.state === 'updating') throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already updating` });
    if (update.latest !== null && update.current === update.latest) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `${update.name} is already on its newest known version` });
    }
    update.state = 'updating';
    update.pending = false;
    this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
    setTimeout(() => {
      update.state = 'idle';
      update.current = update.latest ?? update.current;
      update.checkedAt = Date.now();
      this.#emit('providers.updatesChanged', structuredClone(this.#harnessUpdates));
    }, 1200);
    return structuredClone(update);
  }

  // -------------------------------------------------------------------------
  // Managed installs
  // -------------------------------------------------------------------------

  #managed(providerId: string): ProviderSummary {
    const provider = this.#providers.find((p) => p.id === providerId);
    if (!provider || provider.install === null) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `${providerId} has nothing for Boite to install`
      });
    }
    return provider;
  }

  #setInstall(provider: ProviderSummary, state: ProviderInstallState): void {
    provider.install = state;
    this.#emit('providers.installProgress', { ...state, providerId: provider.id });
  }

  /** The release one install would fetch on this provider, and what it weighs. */
  #release(providerId: string): { version: string; archiveBytes: number } {
    return RELEASES[providerId] ?? { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES };
  }

  #startInstall(providerId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const before = provider.install;
    if (
      before !== null &&
      before.state !== 'absent' &&
      before.state !== 'installed' &&
      before.state !== 'failed'
    ) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `an install of ${providerId} is already running`
      });
    }
    if (before?.state === 'installed' && before.available === before.version) {
      throw new RpcFailure({
        code: RpcErrorCode.Refused,
        message: `${providerId} is up to date on ${before.version}`
      });
    }
    // An update that is cancelled goes back to the release already on disk.
    if (before !== null) this.#installBefore.set(providerId, before);

    const release = this.#release(providerId);
    const operationId = `inst_${(this.#seq += 1)}`;
    const state: ProviderInstallState = {
      state: 'downloading',
      version: release.version,
      receivedBytes: 0,
      totalBytes: release.archiveBytes,
      operationId
    };
    this.#setInstall(provider, state);
    void this.#runInstall(provider, release, operationId);
    return state;
  }

  /** The download ticks, then the two short states, then the files are there. */
  async #runInstall(
    provider: ProviderSummary,
    release: { version: string; archiveBytes: number },
    operationId: string
  ): Promise<void> {
    const running = (): boolean =>
      provider.install !== null &&
      provider.install.state !== 'absent' &&
      provider.install.state !== 'installed' &&
      provider.install.state !== 'failed' &&
      provider.install.operationId === operationId;

    for (let step = 1; step <= INSTALL_STEPS; step += 1) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      if (!running()) return;
      this.#setInstall(provider, {
        state: 'downloading',
        version: release.version,
        receivedBytes: Math.round((release.archiveBytes * step) / INSTALL_STEPS),
        totalBytes: release.archiveBytes,
        operationId
      });
    }
    for (const state of ['verifying', 'extracting'] as const) {
      await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
      if (!running()) return;
      this.#setInstall(provider, { state, version: release.version, operationId });
    }
    await new Promise((resolve) => setTimeout(resolve, INSTALL_STEP_MS));
    if (!running()) return;
    this.#installBefore.delete(provider.id);
    provider.available = true;
    provider.executable = provider.id === MANAGED_ID ? MANAGED_EXE : provider.executable ?? `${DATA_DIR}/agents/${provider.id}/current/${provider.id}.exe`;
    // Same order as the core: the provider list first, so no client sees
    // `installed` on a provider it still believes is missing.
    const installed: ProviderInstallState = {
      state: 'installed',
      version: release.version,
      installedAt: this.#now(),
      available: release.version
    };
    provider.install = installed;
    this.#emit('providers.updated', { loaded: structuredClone(this.#providers), rejected: [] });
    this.#setInstall(provider, installed);
  }

  #cancelInstall(providerId: string, operationId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const current = provider.install;
    if (
      current === null ||
      current.state === 'absent' ||
      current.state === 'installed' ||
      current.state === 'failed'
    ) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: `no install of ${providerId} is running` });
    }
    if (current.operationId !== operationId) {
      throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'that operation is not the one running' });
    }
    const release = this.#release(providerId);
    const back = this.#installBefore.get(providerId);
    this.#installBefore.delete(providerId);
    const state: ProviderInstallState = back ?? {
      state: 'absent',
      version: release.version,
      archiveBytes: release.archiveBytes
    };
    this.#setInstall(provider, state);
    return state;
  }

  #uninstall(providerId: string): ProviderInstallState {
    const provider = this.#managed(providerId);
    const release = this.#release(providerId);
    this.#installBefore.delete(providerId);
    provider.available = false;
    provider.executable = null;
    const state: ProviderInstallState = {
      state: 'absent',
      version: release.version,
      archiveBytes: release.archiveBytes
    };
    this.#setInstall(provider, state);
    this.#emit('providers.updated', { loaded: structuredClone(this.#providers), rejected: [] });
    return state;
  }

  #resources(): ThreadResources[] {
    const out: ThreadResources[] = [];
    for (const thread of this.#threads.values()) {
      const mine = this.#processes.filter((p) => p.threadId === thread.id);
      if (mine.length === 0) continue;
      out.push({
        threadId: thread.id,
        title: thread.title,
        status: thread.status,
        live: mine.filter((p) => p.exitedAt === null),
        totals: {
          processes: mine.length,
          cpuMs: mine.reduce((sum, p) => sum + (p.cpuMs ?? 0), 0),
          peakMemoryBytes: mine.reduce((max, p) => Math.max(max, p.peakMemoryBytes ?? 0), 0)
        }
      });
    }
    return out.sort((a, b) => b.live.length - a.live.length);
  }

  // -------------------------------------------------------------------------
  // Seed: two projects, four threads, one of each interesting state.
  // -------------------------------------------------------------------------

  #seed(): void {
    this.#projects = [
      { id: 'p-boite', name: 'boite', path: 'C:\\src\\boite', createdAt: T0 },
      { id: 'p-notes', name: 'notes', path: 'C:\\src\\notes', createdAt: T0 }
    ];

    // What Claude Code left under its projects folder for boite: one session
    // to import, one that is already the trace thread.
    const transcripts = 'C:\\Users\\you\\.claude\\projects\\D--Dev-Collab-boite';
    this.#importable = [
      {
        projectId: 'p-boite',
        providerId: 'claude',
        accountId: 'a-claude-main',
        sessionId: '4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        file: `${transcripts}\\4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f.jsonl`,
        title: 'Where the shell looks for a core',
        startedAt: T0 - 26 * 3_600_000,
        updatedAt: T0 - 25 * 3_600_000,
        bytes: 184_320,
        threadId: null
      },
      {
        projectId: 'p-boite',
        providerId: 'claude',
        accountId: 'a-claude-main',
        sessionId: '9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b',
        file: `${transcripts}\\9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b.jsonl`,
        title: 'Finish the trace tab',
        startedAt: T0 - 2 * 3_600_000,
        updatedAt: T0 - 3_600_000,
        bytes: 61_440,
        threadId: 't-trace'
      }
    ];

    const { providers, accounts } = seedAccounts();
    this.#providers = providers;
    this.#accounts = accounts;

    const { finished, running, waiting, unread } = seedThreads();

    for (const thread of [finished, running, waiting, unread]) this.#threads.set(thread.id, thread);

    // The project's cards, the list the tasks surface shows under the agent's
    // own: one waiting on the user, one open, one already confirmed. The ids
    // carry a prefix so a card added later never lands on a seeded one.
    this.#todos = [
      { id: 'seed-todo-1', projectId: 'p-boite', text: 'Ship the changes surface', status: 'claimed', threadId: finished.id, createdAt: T0 - 7_200_000, updatedAt: T0 - 600_000 },
      { id: 'seed-todo-2', projectId: 'p-boite', text: 'Give the file tree its rows', status: 'open', threadId: null, createdAt: T0 - 5_400_000, updatedAt: T0 - 5_400_000 },
      { id: 'seed-todo-3', projectId: 'p-boite', text: 'Move the trace behind the panel toggle', status: 'done', threadId: finished.id, createdAt: T0 - 86_400_000, updatedAt: T0 - 3_600_000 },
      { id: 'seed-todo-4', projectId: 'p-notes', text: 'Sort last week into the journal', status: 'open', threadId: null, createdAt: T0 - 86_400_000, updatedAt: T0 - 86_400_000 }
    ];

    if (this.#long) {
      const long = longThread();
      this.#threads.set(long.id, long);
    }

    const seededRequest: PermissionRequest = {
      id: 'req-seed-1',
      threadId: waiting.id,
      turnId: 'turn-seed-3',
      toolName: 'Write',
      input: { path: `${waiting.cwd}\\bench\\run.ts`, contents: 'fifty echo threads, one core' },
      description: 'Write the bench runner inside the project',
      createdAt: T0 + 201_500
    };
    const seededMessage = waiting.messages[1];
    this.#pendingPermissions.set(seededRequest.id, {
      request: seededRequest,
      resolve: (decision) => {
        if (seededMessage) {
          this.#settlePermission(waiting, seededMessage, 1, seededRequest, decision);
          seededMessage.state = 'complete';
          this.#emitToThread(waiting.id, 'message.completed', {
            threadId: waiting.id,
            messageId: seededMessage.id,
            state: 'complete'
          });
        }
        const turn = waiting.turns[0];
        if (turn) {
          turn.status = 'done';
          turn.finishedAt = this.#now();
          this.#emit('turn.finished', structuredClone(turn));
        }
        waiting.status = 'idle';
        this.#touch(waiting);
      }
    });

    const seededQuestion: QuestionRequest = {
      id: 'qst-seed-1',
      threadId: running.id,
      turnId: 'turn-seed-2',
      text: QUESTION_TEXT,
      options: QUESTION_OPTIONS,
      allowText: true,
      multiple: false,
      createdAt: T0 + 171_500
    };
    const questionMessage = running.messages[1];
    this.#pendingQuestions.set(seededQuestion.id, {
      request: seededQuestion,
      resolve: (answer) => {
        if (questionMessage) {
          this.#settleQuestion(running, questionMessage, 1, seededQuestion, answer);
          questionMessage.state = 'complete';
          this.#emitToThread(running.id, 'message.completed', {
            threadId: running.id,
            messageId: questionMessage.id,
            state: 'complete'
          });
        }
        const turn = running.turns[0];
        if (turn) {
          turn.status = 'done';
          turn.finishedAt = this.#now();
          this.#emit('turn.finished', structuredClone(turn));
        }
        running.status = 'idle';
        this.#touch(running);
      }
    });

    this.#processes = [
      {
        pid: 21_140,
        parentPid: 4242,
        threadId: 't-trace',
        exe: 'C:\\tools\\claude\\claude.exe',
        commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
        startedAt: T0 + 1000,
        exitedAt: T0 + 39_000,
        exitCode: 0,
        cpuMs: 4210,
        peakMemoryBytes: 210 * 1024 * 1024,
        ioBytes: 1_240_000
      },
      {
        pid: 21_402,
        parentPid: 21_140,
        threadId: 't-trace',
        exe: 'C:\\tools\\ripgrep\\rg.exe',
        commandLine: 'C:\\tools\\ripgrep\\rg.exe --json process.started packages/core/src',
        startedAt: T0 + 12_000,
        exitedAt: T0 + 12_400,
        exitCode: 0,
        cpuMs: 90,
        peakMemoryBytes: 18 * 1024 * 1024,
        ioBytes: 82_000
      },
      {
        // Gone before the job could read its counters: nothing measured.
        pid: 21_460,
        parentPid: 21_140,
        threadId: 't-trace',
        exe: 'C:\\Program Files\\Git\\cmd\\git.exe',
        commandLine: 'C:\\Program Files\\Git\\cmd\\git.exe status --porcelain',
        startedAt: T0 + 14_000,
        exitedAt: T0 + 14_120,
        exitCode: 0,
        cpuMs: null,
        peakMemoryBytes: null,
        ioBytes: null
      },
      {
        pid: 22_800,
        parentPid: 4242,
        threadId: 't-scheduler',
        exe: 'C:\\tools\\claude\\claude.exe',
        commandLine: 'C:\\tools\\claude\\claude.exe --print --output-format stream-json',
        startedAt: T0 + 170_500,
        exitedAt: null,
        exitCode: null,
        cpuMs: 2100,
        peakMemoryBytes: 380 * 1024 * 1024,
        ioBytes: 640_000
      },
      {
        pid: 22_912,
        parentPid: 22_800,
        threadId: 't-scheduler',
        exe: 'C:\\tools\\bun\\bun.exe',
        commandLine: 'C:\\tools\\bun\\bun.exe test packages/core/src/scheduler.test.ts',
        startedAt: T0 + 176_000,
        exitedAt: null,
        exitCode: null,
        cpuMs: 810,
        peakMemoryBytes: 96 * 1024 * 1024,
        ioBytes: 120_000
      }
    ];

    this.#usage.set('t-trace', {
      inputTokens: 1840,
      outputTokens: 520,
      cacheReadTokens: 12_400,
      cacheWriteTokens: 900,
      costUsdEquivalent: 0.041
    });
    this.#usage.set('t-descriptors', {
      inputTokens: 640,
      outputTokens: 210,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsdEquivalent: 0.008
    });

    this.#scheduler = {
      maxConcurrentTurns: this.#settings.maxConcurrentTurns,
      perAccountConcurrency: this.#settings.perAccountConcurrency,
      running: [{ turnId: 'turn-seed-2', threadId: 't-scheduler', startedAt: T0 + 170_500 }],
      queued: [
        { turnId: 'turn-seed-3', threadId: 't-bench', position: 1, queuedAt: T0 + 200_000 }
      ]
    };

    this.#seq = 100;
  }
}
