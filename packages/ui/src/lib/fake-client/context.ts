import { secureId } from '../secure-id';
import { FakeComposerState } from './composer';
import type { FakeArchiveState, MergedPrFixture } from './merged-pr-archive';
/** The state one fake core keeps, and the plumbing every domain module shares. */
import { observeProgress } from './progress';
import type { FakeRoster } from './group';
import { cancelSecretCards, type FakeSecretCard, type FakeSecretTransit } from './secrets';
import {
  type ClientPreferences,
  type ExperimentId,
  type QuotaAlerts,
  DEFAULT_THREAD_DELETION_RETENTION_DAYS,
  DEFAULT_THREAD_DONE_RETENTION_DAYS,
  PROTOCOL_VERSION,
  SPEECH_DEFAULT_MODEL,
  normalizeCoreLogText,
  normalizeCoreLogOutput,
  normalizeLogData,
  RpcErrorCode,
  processAgentCommand,
  type Attachment,
  type Account,
  type BackgroundTask,
  type AgentLetter,
  type BrainStatus,
  type CoordinationConfig,
  type CoordinationPeer,
  type CoreInfo,
  type CoreLogRecord,
  type DelegationConfig,
  type DelegationWorktree,
  type HarnessUpdate,
  type HooksStatus,
  type ImportableSession,
  type Keybindings,
  type ModelInfo,
  type MemoryState,
  type PairedSession,
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
  type ServerUpdateStatus,
  type DesktopUpdateStatus,
  type SpeechConfig,
  type SpeechStatus,
  type PolicyState,
  type TelemetryState,
  type Thread,
  type ThreadId,
  type ThreadSummary,
  type Todo,
  type Turn,
  type Usage,
} from '@boite/contracts';
import { RpcFailure } from '../client';
import { FakeAgents } from '../fake-agents';
import { checkEffort, checkModel } from './checks';
import { modelsOf } from './provider-catalog';
import { settleAgentSettings } from './agent-settings';
import type { FakeFinishedTurn } from '../fake-usage';
import { activityMethods, finishActivityTurn } from './activity';
import { FakeBus } from './bus';
import { FAKE_TREE } from './files';
import { seedHooks } from './hooks';
import { delegationConfig, workflowAnswer, workflowChild } from './delegation';
import { FakePlugins } from './plugins';
import { initialHarnessUpdates } from './provider-installs';
import { DATA_DIR, T0, toSummary } from './shared';
import { fakeSpeechModels } from './speech';
import { createAgentSession } from './threads';
import { startTurn, stopTurn } from './turns';
import { FakeWorkflows } from './workflows';
import { initialDesktopUpdate, initialServerUpdate } from './server-update';
import { observeLog } from './logs';
import { addGoalCard, agentTodos, followGoal, unlinkGoalCards } from './todos';
import { applyPolicy, lockedSettingsOf, policyFixture } from './policy';
import type { FakeWorktree } from './worktrees';

/**
 * One handler per contract method; plugins, agents and workflows answer from
 * their own classes. `resident.*` is called only by a persistent agent's own
 * `boite` command, never by the UI: the fake core answers it as unknown.
 */
export type FakeMethods = { [M in Exclude<RpcMethodName, `plugins.${string}` | `agents.${string}` | `workflows.${string}` | `resident.${string}`>]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export interface FakeClientOptions {
  /** Explicit peer clients share one core's composer records and attachment assets. */
  composerState?: FakeComposerState;
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /** Exhausted quotas with banked resets and credits for visual checks. */
  quotaExtras?: boolean;
  /** Simulate Windows refusing global instruction symlinks. */
  brainLinkPermission?: boolean;
  /**
   * Characters per streamed delta, like the echo driver's 16, so a per-delta
   * cost shows. Unset streams an answer in five deltas; `?fake=1&stream=tokens` sets 16.
   */
  chunkSize?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
  /** Seeds this many more threads of 400 messages, `t-long-1` and on: what `?fake=1&long=1&copies=16` fills the reading cache with. */
  longCopies?: number;
  /** Seeds one thread of forty messages and 11.5 MiB of tool calls, what `?fake=1&heavy=1` opens the list on. */
  heavy?: boolean;
  /** Seeds one thread whose answer holds diagrams and formulas, what `?fake=1&diagrams=1` opens (`diagrams-thread.ts`). */
  diagrams?: boolean;
  /** Seeds this many more threads at work, their load sampled every second: what `?fake=1&working=16` shows. */
  working?: number;
  /** Seeds this many threads that work without end, what `?fake=1&load=16` streams (`load.ts`). */
  load?: number;
  /** Milliseconds between two ticks of that load, 100 unless `&loadtick=<ms>` says otherwise. */
  loadTickMs?: number;
  /** A fresh machine with no agents, accounts or projects, for the setup flow. */
  uninstalled?: boolean;
  /** Adds a deterministic active team for visual checks on `?fake=1&team=1`. */
  delegationDemo?: boolean;
  /** Two parents at work, one whose sub-agents ask a question and a permission, on `?fake=1&subagents=1`. */
  subagentsDemo?: boolean;
  /** An agent with an entrusted project, a picture, a memory pass and a notice, on `?fake=1&agents=1`. */
  agentsDemo?: boolean;
  /** The project board with cards at work and under review, on `?fake=1&board=1`. */
  boardDemo?: boolean;
  /** Two pull request watches on the trace thread, one paused by GitHub's rate limit, on `?fake=1&watch=1`. */
  watchDemo?: boolean;
  /** Window captures, consent cards in each state and a watched Unity window on the trace thread, on `?fake=1&windows=1`. */
  windowsDemo?: boolean;
  /** Who this client is. `'session'` makes it a paired phone, refused like one. */
  principal?: Principal;
  /** The thread an agent's token names; with none, every agent call fails closed, as on the core. */
  agentThreadId?: ThreadId;
  /** A link nobody encrypts (plain HTTP from another machine): no secret value travels on it; `?fake=1&plainLink=1` sets it. */
  plainLink?: boolean;
  /**
   * Methods this core answers `unknown method` to, like a machine on an older
   * Boite; `?fake=1&missing=diagnostics.summary,diagnostics.export` sets them.
   */
  missing?: readonly string[];
  /**
   * A round trip, in milliseconds, each call waits half of on the way out and
   * half on the way back, like a remote machine; `?fake=1&rtt=150` sets it.
   * Pushed events are not delayed.
   */
  rttMs?: number;
  /** Stable public identity for multi-machine coordination tests. */
  coreId?: string;
  /** The admin policy this core enforces; `?fake=1&policy=managed`, `broken` or `closed` picks a fixture (`policy.ts`). */
  policy?: PolicyState;
  coreName?: string;
  publicUrl?: string;
  /**
   * A desktop app's core: its server updates by hand and its window reports
   * the app's updater, offered at `?desktopUpdate=<phase>`. The second fake
   * machine is one when that parameter is set.
   */
  desktopApp?: boolean;
}

function roundTrip(): number {
  if (typeof location === 'undefined') return 0;
  const rtt = Number(new URLSearchParams(location.search).get('rtt'));
  return Number.isFinite(rtt) && rtt > 0 ? rtt : 0;
}

function tokenStream(): number | undefined {
  if (typeof location === 'undefined') return undefined;
  return new URLSearchParams(location.search).get('stream') === 'tokens' ? 16 : undefined;
}

/** A function of the context, seen from the context: its arguments after `ctx`. */
type Rest<F> = F extends (ctx: FakeContext, ...rest: infer R) => unknown ? R : never;

export class FakeContext {
  readonly composerClientId = secureId();
  readonly composer: FakeComposerState;
  hasProtectedInput(threadId: ThreadId): boolean {
    return this.bus.protectAllThreads || this.bus.protectedThreadIds.has(threadId);
  }
  /** The thread an agent's token names; `becomes('agent', id)` moves it. */
  agentThreadId: ThreadId | null;
  readonly logs: CoreLogRecord[] = [];
  readonly logRunId = secureId();
  logSequence = 0;
  logQueued = new Set<string>();
  readonly logTurns = new Map<string, string>();
  readonly logProcesses = new Map<string, string>();
  serverUpdate: ServerUpdateStatus = initialServerUpdate();
  /** The desktop app's updater as this machine's window reported it; null with no window, or on a server. */
  desktopUpdate: DesktopUpdateStatus | null = null;
  readonly bus: FakeBus;
  readonly agents: FakeAgents;
  /** A settle of the agent setting cards is queued after the current change. */
  private settlingAgentCards = false;
  readonly plugins: FakePlugins;
  readonly workflows: FakeWorkflows;
  /** How far in the past the demo seeds its run, so its steps show real durations. */
  workflowLag = 0;

  brain: BrainStatus = { config: { path: null, enabled: false }, entries: [], problems: [], git: null, lastSync: null };
  /** Each agent's own hooks and the runs that did not pass (`hooks.ts`). */
  hooks: HooksStatus = seedHooks();
  telemetry: TelemetryState = { mode: 'basic', configured: true, pendingDeletion: false };
  /** The user's analytics choice, before the policy's ceiling is applied. */
  telemetryMode: TelemetryState['mode'] = 'basic';
  /** The admin policy, as `policy.get` answers it: none, as on most machines, unless `?policy=` names a fixture (`policy.ts`). */
  policy: PolicyState;
  projects: Project[] = [];
  /** The image of each project whose icon is one, as `projects.icon` answers it. */
  projectImages = new Map<string, { version: string; dataUrl: string }>();
  /** What `git worktree list` would report for each project (`worktrees.ts`). */
  worktrees: FakeWorktree[] = [];
  /** The `pathKey` of each worktree `worktrees.remove` took, so a thread left in one is refused a turn. */
  readonly removedWorktrees = new Set<string>();
  /** The `pathKey` of each folder `FakeClient.loseFolder` took: the fake's stand-in for a deleted repository. */
  readonly goneFolders = new Set<string>();
  /** The sessions Claude Code kept, each tagged with the project whose folder it sits under. */
  importable: (ImportableSession & { projectId: string })[] = [];
  providers: ProviderSummary[] = [];
  readonly modelCatalogs = new Map<string, ModelInfo[]>();
  /** Where each managed install stood before the running one started, for a cancel. */
  readonly installBefore = new Map<string, ProviderInstallState>();
  accounts: Account[] = [];
  readonly mergedPrFixtures = new Map<ThreadId, MergedPrFixture>();
  readonly mergedPrArchive = new Map<ThreadId, FakeArchiveState>();
  readonly removedDefaultProviders = new Set<string>();
  readonly threads = new Map<ThreadId, Thread>();
  readonly deletedThreads = new Map<ThreadId, { threads: Thread[]; archived: boolean[]; deletedAt: number }>();
  readonly coordination = new Map<ThreadId, CoordinationConfig>();
  readonly delegationConfigs = new Map<ThreadId, DelegationConfig>();
  readonly delegationAgents = new Map<ThreadId, { threadId: ThreadId; profileId: string; task: string }[]>();
  readonly delegationLetters = new Map<ThreadId, AgentLetter[]>();
  readonly delegationTurns = new Map<ThreadId, number>();
  readonly delegationRequests = new Map<string, { fingerprint: string; threadId: ThreadId }>();
  /** A child's own worktree, as `delegation.spawn` with `worktree` records it. */
  readonly delegationWorktrees = new Map<ThreadId, DelegationWorktree>();
  readonly delegationSendRequests = new Map<string, { fingerprint: string; letter: AgentLetter }>();
  readonly letters = new Map<ThreadId, AgentLetter[]>();
  readonly peers = new Map<string, CoordinationPeer>();
  readonly groupReads = new Map<string, { groupId: string; epoch: number }>();
  /** The group this fake core is in, shared by reference with the other fake cores of it. */
  roster: FakeRoster | null = null;
  readonly identity: CoordinationPeer;
  readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly activityTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number }>();
  readonly activityGenerations = new Map<string, number>();
  readonly activityAttachments = new Map<string, Attachment[]>();
  processes: ProcessRecord[] = [];
  memoryState: MemoryState = 'ok';
  readonly usage = new Map<ThreadId, Usage>();
  /** Moves asked for during a turn, applied when it ends, as the core's `ThreadMove.waiting`. Memory only. */
  readonly waitingMoves = new Map<ThreadId, { projectId: string; by: 'user' | 'agent'; stopBackground: boolean | undefined; at: number }>();
  /** Turns this session finished, added to the seeded ledger `usage.history` draws. */
  readonly finished: FakeFinishedTurn[] = [];
  usageSeeded = true;
  /** The project todo lists, every thread of a project reading the same cards. */
  todos: Todo[] = [];
  /** Per thread, the user's message that started its automatic goal, as the core's `auto-goal:<thread>` row. */
  readonly autoGoalMessages = new Map<string, string>();
  /** The experiments a queued prompt was queued with, read by `turns.start` while the composer delivers it. */
  queuedExperiments: readonly string[] | null = null;
  /** The working tree `files.list`, `files.read` and `files.write` share. */
  readonly files = new Map<string, string>(Object.entries(FAKE_TREE));
  readonly artifactUrls = new Set<string>();
  private storedSettings!: Settings;

  /** As in the core, policy values are read over the saved choices, never saved over them. */
  get settings(): Settings {
    const saved = this.storedSettings;
    return this.policy?.present ? { ...saved, ...lockedSettingsOf(this.policy.values, saved) } : saved;
  }

  set settings(next: Settings) {
    const saved = this.storedSettings;
    if (!saved || !this.policy?.present) { this.storedSettings = next; return; }
    const held = lockedSettingsOf(this.policy.values, saved);
    const kept = { ...next };
    for (const key of ['listenOnLan', 'autoInstallUpdates', 'autoUpdateHarnesses', 'groupThreads', 'groupBots'] as const) {
      if (key in held) Object.assign(kept, { [key]: saved[key] });
    }
    // Configuring a gateway while its switch is held off still saves the new address.
    const proxy = kept.subscriptionProxy;
    if (proxy && !proxy.enabled && saved.subscriptionProxy?.enabled && lockedSettingsOf(this.policy.values, { ...saved, subscriptionProxy: { ...proxy, enabled: true } }).subscriptionProxy) {
      kept.subscriptionProxy = { ...proxy, enabled: true };
    }
    this.storedSettings = kept;
  }
  /** What the app last said of itself (`client.preferences`); the fake core has one app. */
  clientPreferences: ClientPreferences | null = null;
  /** Each app's last report by its id, as the core's book keeps them. */
  readonly clientApps = new Map<string, ClientPreferences>();
  /** What the fake machine's desktop app has on, as `client.desktopExperiments` says; null before it reported. */
  desktopExperiments: ExperimentId[] | null = null;
  speech: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '', model: SPEECH_DEFAULT_MODEL };
  readonly speechStatus: SpeechStatus = { revision: 'fake-voice', engine: 'local', ready: true, localReady: true, groqKeySet: false, openrouterKeySet: false, installing: false, downloadedBytes: 0, totalBytes: 0, error: null, canInstallRuntime: true, models: fakeSpeechModels(), downloading: null, runtimeOutdated: false };
  readonly speechRequests = new Map<string, symbol>();
  /** A file with one moved chord, one taken away, and one line the core refused. */
  keybindings: Keybindings = {
    path: `${DATA_DIR}\\keybindings.json`,
    bindings: { 'theme-light': 'mod+shift+l', panel: null },
    errors: ['keybindings.json: "trace": "t" has no modifier: a chord needs mod, ctrl, alt or meta before its key']
  };
  readonly quotaEnabled: Record<string, boolean> = {};
  /** What `quotas.alert` saved, per account or gateway entry. */
  readonly quotaAlerts: Record<string, QuotaAlerts> = {};
  readonly quotaResetsUsed: Record<string, number> = {};
  scheduler: SchedulerState;
  readonly core: CoreInfo;
  /** One phone already paired, so the devices list has a row to revoke. */
  sessions: PairedSession[] = [
    { id: 'ses-phone', client: { name: 'pwa', version: '2.0.0-beta.1' }, role: 'device', createdAt: T0, lastSeenAt: T0 + 600_000, current: false },
    { id: 'ses-laptop', client: { name: 'shell', version: '2.0.0-beta.1' }, role: 'owner', createdAt: T0, lastSeenAt: T0 + 300_000, current: false }
  ];

  /** The request itself is kept beside its resolver, which is what `permissions.list` answers with. */
  readonly pendingPermissions = new Map<
    string,
    { request: PermissionRequest; resolve: (decision: 'allow' | 'deny') => void }
  >();
  /** Same shape for the questions: the request kept beside what settles it. */
  readonly pendingQuestions = new Map<
    string,
    { request: QuestionRequest; resolve: (answer: QuestionAnswer | null) => void }
  >();
  /** Open cards and synthetic transit metadata: never a value or a project key. */
  readonly pendingSecrets = new Map<string, FakeSecretCard>();
  readonly secretTransits = new Map<string, FakeSecretTransit>();
  readonly settledSecrets = new Map<string, { threadId: Thread['id']; result: RpcResult<'secrets.ask'> }>();
  readonly inFlight = new Map<ThreadId, { cancelled: boolean; done: Promise<void>; steered?: { prompt: string; attachments: Attachment[] }[] }>();
  private readonly toolBoundaries = new Set<string>();
  /** Async answers waiting for the thread to be free, oldest first. */
  readonly heldAnswers = new Map<ThreadId, string[]>();
  /** The current output of every active fake login, also returned after reconnect. */
  readonly logins = new Map<string, RpcEvents['account.login']>();
  /** Fake shells by terminal id: what they printed and the line being typed. */
  /** Each fake shell marks its prompts and commands as the core's integrated PowerShell does; `history` is newest last. */
  readonly terminals = new Map<string, { cwd: string; output: string; line: string; sequence?: number; history: string[] }>();
  /** Threads whose title is being written, which the core refuses a second ask for. */
  readonly retitling = new Set<ThreadId>();
  seq = 0;
  readonly turnRequests = new Map<string, { content: string; turn: Turn; messageId: string }>();
  readonly delayMs: number;
  readonly rttMs: number;
  readonly chunkSize: number | undefined;
  readonly long: boolean;
  readonly longCopies: number;
  readonly heavy: boolean;
  readonly diagrams: boolean;
  readonly quotaExtras: boolean;
  readonly plainLink: boolean;
  brainLinkPermission: boolean;
  /**
   * Two agents behind their newest release, one by each route, so the notices
   * have a subject (`provider-installs.ts`).
   */
  readonly harnessUpdates: HarnessUpdate[] = initialHarnessUpdates();

  constructor(options: FakeClientOptions = {}) {
    this.composer = options.composerState ?? new FakeComposerState();
    this.quotaExtras = options.quotaExtras ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('quotaExtras') === '1');
    this.brainLinkPermission = options.brainLinkPermission ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('brainLinkPermission') === '1');
    this.plainLink = options.plainLink ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('plainLink') === '1');
    this.bus = new FakeBus(options.principal ?? 'owner', { threadId: () => this.agentThreadId, projectOf: id => this.threads.get(id)?.projectId ?? null, visibleTodos: (id, todos) => agentTodos(this, id, todos) });
    this.agents = new FakeAgents(revision => {
      this.emit('agents.changed', { revision });
      // As the core: a change to any agent may answer a card, settled once per burst after it commits.
      if (this.settlingAgentCards) return;
      this.settlingAgentCards = true;
      queueMicrotask(() => { this.settlingAgentCards = false; settleAgentSettings(this); });
    }, {
      create: (agent, sessionId) => createAgentSession(this, agent, sessionId),
      // A wake runs on the thread like a turn the user started; one already running refuses it, as the composer's queue would wait.
      wake: (threadId, prompt, operation, label) => this.startTurn(threadId, prompt, [], operation, undefined, undefined, [], false, label),
      thread: threadId => this.threads.get(threadId),
      settle: threadId => { const thread = this.threads.get(threadId); if (thread?.unread) { thread.unread = false; this.touch(thread); } },
      waiting: threadId => [...this.pendingQuestions.values()].some(q => q.request.threadId === threadId) || [...this.pendingPermissions.values()].some(p => p.request.threadId === threadId),
      question: threadId => {
        const ask = [...this.pendingQuestions.values()].find(q => q.request.threadId === threadId)?.request;
        return ask ? { id: ask.id, text: ask.text, options: ask.options.map(o => o.label) } : null;
      },
      goal: (threadId, objective) => {
        const methods = activityMethods(this);
        void (objective === null ? methods['threads.activity.control']({ threadId, kind: 'goal', action: 'remove' }) : methods['threads.activity.set']({ threadId, goal: { objective } })).catch(() => {});
      },
      // A project's folder holds files: a brain root refuses it.
      occupied: path => this.projects.some(p => p.path.replace(/[\\/]+$/, '') === path),
      checkRoute: (value, previous) => {
        const provider = this.providers.find(p => p.id === value.providerId);
        const account = this.accounts.find(a => a.id === value.accountId);
        if (!provider || !account || account.providerId !== provider.id) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'route.accountId: expected an account of route.providerId' });
        const models = modelsOf(this, provider.id, account.id);
        const kept = previous?.providerId === provider.id && previous.accountId === account.id && previous.model === value.model;
        if (!kept) checkModel(provider, account.id, models, value.model, this.modelCatalogs.has(provider.id + '::' + account.id));
        if (!kept || previous.effort !== value.effort) checkEffort(provider, models, value.model, value.effort);
      },
    });
    this.plugins = new FakePlugins({
      emit: (event, payload) => this.emit(event, payload),
      now: () => this.now(),
      nextId: () => ++this.seq,
      delayMs: () => this.delayMs,
    });
    this.workflows = new FakeWorkflows({
      thread: threadId => this.thread(threadId),
      config: rootId => delegationConfig(this, rootId),
      resumeTeam: rootId => {
        this.delegationConfigs.set(rootId, { ...delegationConfig(this, rootId), paused: false });
        this.emit('delegation.changed', { threadId: rootId });
      },
      child: (root, profile, title, task) => workflowChild(this, root, profile, title, task),
      answer: (threadId, text, ok) => workflowAnswer(this, threadId, text, ok),
      changed: (rootId, runId) => this.emitToThread(rootId, 'workflows.changed', { threadId: rootId, runId }),
      // The wall clock, as the team demo uses: a running step's elapsed time counts from it.
      now: () => Date.now() + this.workflowLag,
      delayMs: () => this.delayMs,
      principal: () => this.bus.principal,
    });
    this.delayMs = options.delayMs ?? 18;
    this.rttMs = options.rttMs ?? roundTrip();
    this.chunkSize = options.chunkSize ?? tokenStream();
    this.long = options.long ?? false;
    this.longCopies = options.longCopies ?? 0;
    this.heavy = options.heavy ?? false;
    this.diagrams = options.diagrams ?? false;
    const coreId = options.coreId ?? `${secureId()}${secureId()}`;
    if (options.desktopApp) {
      this.serverUpdate = { ...this.serverUpdate, mode: 'manual', phase: 'idle', version: null, publishedAt: null, received: 0, total: null, error: null };
      this.desktopUpdate = initialDesktopUpdate();
    }
    this.agentThreadId = options.agentThreadId ?? null;
    this.identity = {
      coreId,
      name: options.coreName ?? 'This PC',
      url: options.publicUrl ?? 'http://127.0.0.1:8777',
      publicKey: `fake-public-key-${coreId}`
    };
    this.settings = {
      threadDeletionRetentionDays: DEFAULT_THREAD_DELETION_RETENTION_DAYS,
      threadDoneRetentionDays: DEFAULT_THREAD_DONE_RETENTION_DAYS,
      warmProcessMinutes: 0,
      worktreeStorage: { mode: 'project', directory: null },
      listenOnLan: false,
      agentCpuCapPercent: 75,
      agentMemoryBudgetPercent: 60,
      threadMemoryCapMb: 0,
      memoryReserveMb: 0,
      memoryProtection: true,
      focusGuard: true,
      muteAgents: true,
      reapOrphans: true,
      autoUpdateHarnesses: false
    };
    // `?gateway=douane` or `cliproxyapi`: a gateway the owner saved and turned off, for a paired phone to switch on.
    const gateway = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('gateway');
    if (gateway === 'douane' || gateway === 'cliproxyapi') {
      this.settings.subscriptionProxy = { enabled: false, kind: gateway, baseUrl: 'https://gateway.example.test/v1',
        dashboardUrl: gateway === 'douane' ? 'https://gateway.example.test/admin/#quotas' : 'https://gateway.example.test/management.html#/quota' };
    }
    this.core = {
      version: '2.0.0-beta.1',
      coreId,
      protocolVersion: PROTOCOL_VERSION,
      features: { draftPreparation: true, attachmentUploads: true, threadSnapshots: true, chunkedAnswers: true, readingPages: true, messagePositions: true, deferredToolParts: true, deviceKeys: true, revealMachines: true, loadEvents: true, desktopUpdates: true, gatewayMove: true, projectBoard: true, settingsHome: true, sharedProjects: 1 },
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
    this.scheduler = {
      running: [],
      queued: []
    };
    this.policy = options.policy ?? policyFixture(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('policy'));
    applyPolicy(this);
  }

  // -------------------------------------------------------------------------
  // The turn engine, reached from the modules it would otherwise import back
  // -------------------------------------------------------------------------

  startTurn(...args: Rest<typeof startTurn>): Turn {
    return startTurn(this, ...args);
  }

  stopTurn(...args: Rest<typeof stopTurn>): Promise<boolean> {
    return stopTurn(this, ...args);
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  now(): number {
    return T0 + this.seq * 1000;
  }

  tick(): Promise<void> {
    return Promise.resolve();
  }

  /** One way of a call's trip: half the simulated round trip. */
  leg(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.rttMs / 2));
  }

  pause(): Promise<void> {
    if (this.delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  emit<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
    this.composer.observe(this, event, payload);
    if (event === 'thread.removed') cancelSecretCards(this, (payload as RpcEvents['thread.removed']).threadId);
    if (event === 'thread.updated') {
      const thread = payload as RpcEvents['thread.updated'];
      if (thread.archived) cancelSecretCards(this, thread.id);
    }
    if (event === 'turn.finished') {
      const turn = payload as RpcEvents['turn.finished'];
      cancelSecretCards(this, turn.threadId, turn.id);
    }
    if (event === 'core.log') {
      const log = payload as RpcEvents['core.log'];
      const bounded = (value: string): string => normalizeCoreLogText(value).replace(/[\r\n\t]/g, ' ').slice(0, 200);
      payload = { level: log.level, at: log.at, message: log.kind === 'provider-output' ? normalizeCoreLogOutput(log.message) : normalizeCoreLogText(log.message), source: bounded(log.source ?? 'core'), event: bounded(log.event ?? 'core.log'),
        ...(log.threadId === undefined ? {} : { threadId: bounded(log.threadId) }), ...(log.turnId === undefined ? {} : { turnId: bounded(log.turnId) }), ...(log.requestId === undefined ? {} : { requestId: bounded(log.requestId) }),
        ...(typeof log.durationMs === 'number' && Number.isFinite(log.durationMs) && log.durationMs >= 0 ? { durationMs: Math.round(log.durationMs) } : {}),
        ...(log.data === undefined ? {} : (() => { const data = normalizeLogData(log.data); return data ? { data } : {}; })()),
        ...(log.kind === 'provider-output' ? { kind: log.kind } : {}),
      } as RpcEvents[E];
    }
    observeLog(this, event, payload);
    if (event === 'thread.removed') this.agents.threadEnded((payload as RpcEvents['thread.removed']).threadId);
    if (event === 'thread.updated' && (payload as RpcEvents['thread.updated']).archived) this.agents.threadEnded((payload as RpcEvents['thread.updated']).id);
    if (event === 'turn.finished') {
      const turn = payload as Turn;
      const agentThread = this.threads.get(turn.threadId);
      const answer = () => agentThread?.messages.filter(m => m.turnId === turn.id && m.role === 'assistant').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n') ?? '';
      // The final text block, as the core reads it for `[quiet]`.
      const finalText = () => agentThread?.messages.filter(m => m.turnId === turn.id && m.role === 'assistant').flatMap(m => m.parts.flatMap(p => p.type === 'text' && p.text.trim() ? [p.text] : [])).at(-1) ?? '';
      if (agentThread?.agentSessionId) this.agents.finished(turn, finalText());
      const goal = agentThread?.activity?.goal?.status;
      finishActivityTurn(this, turn);
      this.agents.goalEnded(turn, goal, answer);
    }
    this.bus.deliver(event, payload);
    if (event === 'process.started' || event === 'process.exited') {
      const record = payload as ProcessRecord;
      if (processAgentCommand(record)) this.emit('delegation.changed', { threadId: record.threadId });
    }
  }

  emitToThread<E extends RpcEventName>(threadId: ThreadId, event: E, payload: RpcEvents[E]): void {
    observeProgress(this, threadId, event, payload);
    if (this.bus.subscribed.has(threadId)) this.emit(event, payload);
    else observeLog(this, event, payload);
    if (event === 'message.part') {
      const { messageId, partIndex, part } = payload as RpcEvents['message.part'];
      const boundary = `${messageId}:${partIndex}`;
      const message = this.threads.get(threadId)?.messages.find(message => message.id === messageId);
      if (message && part.type === 'tool' && part.status !== 'running' && !this.toolBoundaries.has(boundary)) {
        this.toolBoundaries.add(boundary);
        this.emit('turn.toolCompleted', { threadId, turnId: message.turnId, boundary });
      }
    }
  }

  thread(threadId: ThreadId): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no such thread: ${threadId}`, data: { threadId } });
    return thread;
  }

  notFound(what: string, id: string): RpcFailure {
    return new RpcFailure({
      code: RpcErrorCode.NotFound,
      message: `no such ${what}: ${id}`,
      data: { id }
    });
  }

  touch(thread: Thread): ThreadSummary {
    thread.updatedAt = this.now();
    const summary = structuredClone(toSummary(thread));
    this.emit('thread.updated', summary);
    return structuredClone(summary);
  }

  setBackground(thread: Thread, tasks: BackgroundTask[], ended: 'no-longer-reported' | 'session-ended' = 'no-longer-reported'): void {
    const at = this.now();
    const history = thread.backgroundHistory ??= [];
    const parentTurnId = thread.turns.at(-1)?.id ?? null;
    for (const task of history) {
      if (task.state === 'running' && !tasks.some(next => next.id === task.id)) {
        Object.assign(task, { state: ended === 'session-ended' ? 'cancelled' : 'ended', reason: ended, observedAt: at, finishedAt: at });
      }
    }
    for (const task of tasks) {
      const prior = history.find(entry => entry.id === task.id && entry.providerId === thread.providerId
        && entry.sessionGeneration === (thread.sessionGeneration ?? 0) && (entry.state === 'running' || entry.parentTurnId === parentTurnId));
      if (prior) { if (prior.state === 'running') Object.assign(prior, task, { observedAt: at }); }
      else history.push({ ...task, threadId: thread.id, providerId: thread.providerId, sessionGeneration: thread.sessionGeneration ?? 0,
        parentTurnId, state: 'running', observedAt: at, finishedAt: null, reason: null });
    }
    thread.backgroundHistory = history.slice(-100);
    thread.background = tasks;
    this.emit('thread.background', { threadId: thread.id, tasks: structuredClone(tasks), history: structuredClone(thread.backgroundHistory) });
    this.emit('thread.updated', structuredClone(toSummary(thread)));
  }

  /** An automatic goal's card and its unlinking, here so `activity.ts` reaches the board without importing it. */
  addGoalCard(thread: Thread, prompt: string): void { addGoalCard(this, thread, prompt); }
  unlinkGoalCards(thread: Thread): void { unlinkGoalCards(this, thread); }

  publishActivity(thread: Thread): void {
    this.emit('thread.activity', { threadId: thread.id, activity: structuredClone(thread.activity!) });
    followGoal(this, thread);
  }
}
