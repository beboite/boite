import { secureId } from '../secure-id';
import type { FakeArchiveState, MergedPrFixture } from './merged-pr-archive';
/** The state one fake core keeps, and the plumbing every domain module shares. */
import { observeProgress } from './progress';
import type { FakeRoster } from './group';
import {
  DEFAULT_THREAD_DELETION_RETENTION_DAYS,
  DEFAULT_THREAD_DONE_RETENTION_DAYS,
  PROTOCOL_VERSION,
  SPEECH_DEFAULT_MODEL,
  normalizeCoreLogText,
  normalizeCoreLogOutput,
  RpcErrorCode,
  processAgentCommand,
  type Attachment,
  type Account,
  type BackgroundTask,
  type AgentLetter,
  type StewardGrant,
  type BrainStatus,
  type CoordinationConfig,
  type CoordinationPeer,
  type CoreInfo,
  type CoreLogRecord,
  type DelegationConfig,
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
  type SpeechConfig,
  type SpeechStatus,
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
import { initialServerUpdate } from './server-update';
import { observeLog } from './logs';
import type { FakeWorktree } from './worktrees';

/** One handler per contract method; plugins, agents and workflows answer from their own classes. */
export type FakeMethods = { [M in Exclude<RpcMethodName, `plugins.${string}` | `agents.${string}` | `workflows.${string}`>]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export interface FakeClientOptions {
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /** Exhausted quotas with banked resets and credits for visual checks. */
  quotaExtras?: boolean;
  /**
   * Characters per streamed delta, like the echo driver's 16, so a per-delta
   * cost shows. Unset streams an answer in five deltas; `?fake=1&stream=tokens` sets 16.
   */
  chunkSize?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
  /** Seeds one thread of forty messages and 11.5 MiB of tool calls, what `?fake=1&heavy=1` opens the list on. */
  heavy?: boolean;
  /** A fresh machine with no agents, accounts or projects, for the setup flow. */
  uninstalled?: boolean;
  /** Adds a deterministic active team for visual checks on `?fake=1&team=1`. */
  delegationDemo?: boolean;
  /** A steward thread with a letter it sent, a notice it received and a thread its agent started, on `?fake=1&steward=1`. */
  stewardDemo?: boolean;
  /** A Douane as the subscription proxy and three threads at work for the companion's HUD, on `?fake=1&hud=1`. */
  hudDemo?: boolean;
  /** Who this client is. `'session'` makes it a paired phone, refused like one. */
  principal?: Principal;
  /** Stable public identity for multi-machine coordination tests. */
  coreId?: string;
  coreName?: string;
  publicUrl?: string;
}

function tokenStream(): number | undefined {
  if (typeof location === 'undefined') return undefined;
  return new URLSearchParams(location.search).get('stream') === 'tokens' ? 16 : undefined;
}

/** A function of the context, seen from the context: its arguments after `ctx`. */
type Rest<F> = F extends (ctx: FakeContext, ...rest: infer R) => unknown ? R : never;

export class FakeContext {
  hasProtectedInput(threadId: ThreadId): boolean {
    return this.bus.protectAllThreads || this.bus.protectedThreadIds.has(threadId);
  }
  readonly logs: CoreLogRecord[] = [];
  readonly logRunId = secureId();
  logSequence = 0;
  logQueued = new Set<string>();
  readonly logTurns = new Map<string, string>();
  readonly logProcesses = new Map<string, string>();
  serverUpdate: ServerUpdateStatus = initialServerUpdate();
  readonly bus: FakeBus;
  readonly agents: FakeAgents;
  readonly plugins: FakePlugins;
  readonly workflows: FakeWorkflows;
  /** How far in the past the demo seeds its run, so its steps show real durations. */
  workflowLag = 0;

  brain: BrainStatus = { config: { path: null, enabled: false }, entries: [], problems: [], git: null, lastSync: null };
  /** Each agent's own hooks and the runs that did not pass (`hooks.ts`). */
  hooks: HooksStatus = seedHooks();
  telemetry: TelemetryState = { mode: 'basic', configured: true, pendingDeletion: false };
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
  readonly delegationSendRequests = new Map<string, { fingerprint: string; letter: AgentLetter }>();
  readonly letters = new Map<ThreadId, AgentLetter[]>();
  /** Steward grants by steward thread (`stewards.ts`). */
  readonly stewards = new Map<ThreadId, StewardGrant>();
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
  /** The working tree `files.list`, `files.read` and `files.write` share. */
  readonly files = new Map<string, string>(Object.entries(FAKE_TREE));
  readonly artifactUrls = new Set<string>();
  settings: Settings;
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
  readonly inFlight = new Map<ThreadId, { cancelled: boolean; done: Promise<void>; steered?: { prompt: string; attachments: Attachment[] }[] }>();
  private readonly toolBoundaries = new Set<string>();
  /** Async answers waiting for the thread to be free, oldest first. */
  readonly heldAnswers = new Map<ThreadId, string[]>();
  /** The current output of every active fake login, also returned after reconnect. */
  readonly logins = new Map<string, RpcEvents['account.login']>();
  /** Fake shells by terminal id: what they printed and the line being typed. */
  readonly terminals = new Map<string, { cwd: string; output: string; line: string; sequence?: number }>();
  /** Threads whose title is being written, which the core refuses a second ask for. */
  readonly retitling = new Set<ThreadId>();
  seq = 0;
  readonly turnRequests = new Map<string, { content: string; turn: Turn; messageId: string }>();
  readonly delayMs: number;
  readonly chunkSize: number | undefined;
  readonly long: boolean;
  readonly heavy: boolean;
  readonly quotaExtras: boolean;
  /** Seeds what the companion's HUD shows (`hud-demo.ts`). */
  readonly hudDemo: boolean;
  /**
   * Two agents behind their newest release, one by each route, so the notices
   * have a subject (`provider-installs.ts`).
   */
  readonly harnessUpdates: HarnessUpdate[] = initialHarnessUpdates();

  constructor(options: FakeClientOptions = {}) {
    this.quotaExtras = options.quotaExtras ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('quotaExtras') === '1');
    this.hudDemo = options.hudDemo ?? (typeof location !== 'undefined' && new URLSearchParams(location.search).get('hud') === '1');
    this.bus = new FakeBus(options.principal ?? 'owner');
    this.agents = new FakeAgents(revision => this.emit('agents.changed', { revision }), {
      create: (agent, sessionId, work) => createAgentSession(this, agent, sessionId, work),
      start: (threadId, prompt, agent) => { Object.assign(this.thread(threadId), agent.selection); return this.startTurn(threadId, prompt); },
      stop: threadId => { void this.stopTurn(threadId); },
      protocol: providerId => this.providers.find(p => p.id === providerId)?.protocol,
      thread: threadId => this.threads.get(threadId),
      goal: (threadId, objective) => {
        const methods = activityMethods(this);
        void (objective === null ? methods['threads.activity.control']({ threadId, kind: 'goal', action: 'remove' }) : methods['threads.activity.set']({ threadId, goal: { objective } })).catch(() => {});
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
    this.chunkSize = options.chunkSize ?? tokenStream();
    this.long = options.long ?? false;
    this.heavy = options.heavy ?? false;
    const coreId = options.coreId ?? `fake-core-${secureId()}`;
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
    this.core = {
      version: '2.0.0-beta.1',
      protocolVersion: PROTOCOL_VERSION,
      features: { threadSnapshots: true, chunkedAnswers: true, readingPages: true, deferredToolParts: true },
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

  pause(): Promise<void> {
    if (this.delayMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  emit<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
    if (event === 'core.log') {
      const log = payload as RpcEvents['core.log'];
      const bounded = (value: string): string => normalizeCoreLogText(value).replace(/[\r\n\t]/g, ' ').slice(0, 200);
      payload = { level: log.level, at: log.at, message: log.kind === 'provider-output' ? normalizeCoreLogOutput(log.message) : normalizeCoreLogText(log.message), source: bounded(log.source ?? 'core'), event: bounded(log.event ?? 'core.log'),
        ...(log.threadId === undefined ? {} : { threadId: bounded(log.threadId) }), ...(log.turnId === undefined ? {} : { turnId: bounded(log.turnId) }), ...(log.requestId === undefined ? {} : { requestId: bounded(log.requestId) }),
        ...(log.kind === 'provider-output' ? { kind: log.kind } : {}),
      } as RpcEvents[E];
    }
    observeLog(this, event, payload);
    if (event === 'turn.finished') {
      const turn = payload as Turn;
      const agentThread = this.threads.get(turn.threadId);
      const answer = () => agentThread?.messages.filter(m => m.turnId === turn.id && m.role === 'assistant').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n') ?? '';
      if (agentThread?.agentSessionId) this.agents.finished(turn, answer());
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

  publishActivity(thread: Thread): void {
    this.emit('thread.activity', { threadId: thread.id, activity: structuredClone(thread.activity!) });
  }
}
