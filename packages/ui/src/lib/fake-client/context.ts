/** The state one fake core keeps, and the plumbing every domain module shares. */
import {
  PROTOCOL_VERSION,
  RpcErrorCode,
  type Account,
  type BackgroundTask,
  type AgentLetter,
  type BrainStatus,
  type CoordinationConfig,
  type CoordinationPeer,
  type CoreInfo,
  type DelegationConfig,
  type HarnessUpdate,
  type ImportableSession,
  type Keybindings,
  type ModelInfo,
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
import { finishActivityTurn } from './activity';
import { FakeBus } from './bus';
import { FAKE_TREE } from './files';
import { delegationConfig, workflowAnswer, workflowChild } from './delegation';
import { FakePlugins } from './plugins';
import { initialHarnessUpdates } from './provider-installs';
import { DATA_DIR, T0, toSummary } from './shared';
import { createAgentSession } from './threads';
import { startTurn, stopTurn } from './turns';
import { FakeWorkflows } from './workflows';

/** One handler per contract method; plugins, agents and workflows answer from their own classes. */
export type FakeMethods = { [M in Exclude<RpcMethodName, `plugins.${string}` | `agents.${string}` | `workflows.${string}`>]: (params: RpcParams<M>) => Promise<RpcResult<M>> };

export interface FakeClientOptions {
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /**
   * Characters per streamed delta, like the echo driver's 16, so a per-delta
   * cost shows. Unset streams an answer in five deltas; `?fake=1&stream=tokens` sets 16.
   */
  chunkSize?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
  /** A fresh machine with no agents, accounts or projects, for the setup flow. */
  uninstalled?: boolean;
  /** Adds a deterministic active team for visual checks on `?fake=1&team=1`. */
  delegationDemo?: boolean;
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
  readonly bus: FakeBus;
  readonly agents: FakeAgents;
  readonly plugins: FakePlugins;
  readonly workflows: FakeWorkflows;
  /** How far in the past the demo seeds its run, so its steps show real durations. */
  workflowLag = 0;

  brain: BrainStatus = { config: { path: null, enabled: false }, entries: [], problems: [], git: null, lastSync: null };
  telemetry: TelemetryState = { mode: 'basic', configured: true, pendingDeletion: false };
  projects: Project[] = [];
  /** The sessions Claude Code kept, each tagged with the project whose folder it sits under. */
  importable: (ImportableSession & { projectId: string })[] = [];
  providers: ProviderSummary[] = [];
  readonly modelCatalogs = new Map<string, ModelInfo[]>();
  /** Where each managed install stood before the running one started, for a cancel. */
  readonly installBefore = new Map<string, ProviderInstallState>();
  accounts: Account[] = [];
  readonly threads = new Map<ThreadId, Thread>();
  readonly coordination = new Map<ThreadId, CoordinationConfig>();
  readonly delegationConfigs = new Map<ThreadId, DelegationConfig>();
  readonly delegationAgents = new Map<ThreadId, { threadId: ThreadId; profileId: string; task: string }[]>();
  readonly delegationLetters = new Map<ThreadId, AgentLetter[]>();
  readonly delegationTurns = new Map<ThreadId, number>();
  readonly delegationRequests = new Map<string, { fingerprint: string; threadId: ThreadId }>();
  readonly delegationSendRequests = new Map<string, { fingerprint: string; letter: AgentLetter }>();
  readonly letters = new Map<ThreadId, AgentLetter[]>();
  readonly peers = new Map<string, CoordinationPeer>();
  readonly identity: CoordinationPeer;
  readonly activityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly activityTurns = new Map<string, { kind: 'goal' | 'loop'; generation: number }>();
  readonly activityGenerations = new Map<string, number>();
  processes: ProcessRecord[] = [];
  readonly usage = new Map<ThreadId, Usage>();
  /** Turns this session finished, added to the seeded ledger `usage.history` draws. */
  readonly finished: FakeFinishedTurn[] = [];
  usageSeeded = true;
  /** The project todo lists, every thread of a project reading the same cards. */
  todos: Todo[] = [];
  /** The working tree `files.list`, `files.read` and `files.write` share. */
  readonly files = new Map<string, string>(Object.entries(FAKE_TREE));
  settings: Settings;
  speech: SpeechConfig = { engine: 'local', language: '', apiProvider: 'groq', fallback: false, executable: '', modelPath: '' };
  readonly speechStatus: SpeechStatus = { revision: 'fake-voice', engine: 'local', ready: true, localReady: true, groqKeySet: false, openrouterKeySet: false, installing: false, downloadedBytes: 0, totalBytes: 190085487, error: null, canInstallRuntime: true };
  readonly speechRequests = new Map<string, symbol>();
  /** A file with one moved chord, one taken away, and one line the core refused. */
  keybindings: Keybindings = {
    path: `${DATA_DIR}\\keybindings.json`,
    bindings: { 'theme-light': 'mod+shift+l', panel: null },
    errors: ['keybindings.json: "trace": "t" has no modifier: a chord needs mod, ctrl, alt or meta before its key']
  };
  readonly quotaEnabled: Record<string, boolean> = {};
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
  readonly inFlight = new Map<ThreadId, { cancelled: boolean; done: Promise<void> }>();
  /** Async answers waiting for the thread to be free, oldest first. */
  readonly heldAnswers = new Map<ThreadId, string[]>();
  /** The current output of every active fake login, also returned after reconnect. */
  readonly logins = new Map<string, RpcEvents['account.login']>();
  /** Fake shells by terminal id: what they printed and the line being typed. */
  readonly terminals = new Map<string, { cwd: string; output: string; line: string }>();
  /** Threads whose title is being written, which the core refuses a second ask for. */
  readonly retitling = new Set<ThreadId>();
  seq = 0;
  readonly turnRequests = new Map<string, { content: string; turn: Turn }>();
  readonly delayMs: number;
  readonly chunkSize: number | undefined;
  readonly long: boolean;
  /**
   * Two agents behind their newest release, one by each route, so the notices
   * have a subject (`provider-installs.ts`).
   */
  readonly harnessUpdates: HarnessUpdate[] = initialHarnessUpdates();

  constructor(options: FakeClientOptions = {}) {
    this.bus = new FakeBus(options.principal ?? 'owner');
    this.agents = new FakeAgents(revision => this.emit('agents.changed', { revision }), {
      create: (agent, sessionId, work) => createAgentSession(this, agent, sessionId, work),
      start: (threadId, prompt, agent) => { Object.assign(this.thread(threadId), agent.selection); return this.startTurn(threadId, prompt); },
      stop: threadId => { void this.stopTurn(threadId); },
      protocol: providerId => this.providers.find(p => p.id === providerId)?.protocol,
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
    const coreId = options.coreId ?? `fake-core-${crypto.randomUUID()}`;
    this.identity = {
      coreId,
      name: options.coreName ?? 'This PC',
      url: options.publicUrl ?? 'http://127.0.0.1:8777',
      publicKey: `fake-public-key-${coreId}`
    };
    this.settings = {
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 0,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
      focusGuard: true,
      muteAgents: true,
      reapOrphans: true,
      autoUpdateHarnesses: false
    };
    this.core = {
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
    this.scheduler = {
      maxConcurrentTurns: this.settings.maxConcurrentTurns,
      perAccountConcurrency: this.settings.perAccountConcurrency,
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
    if (event === 'turn.finished') {
      const turn = payload as Turn;
      const agentThread = this.threads.get(turn.threadId);
      if (agentThread?.agentSessionId) this.agents.finished(turn, agentThread.messages.filter(m => m.turnId === turn.id && m.role === 'assistant').flatMap(m => m.parts.flatMap(p => p.type === 'text' ? [p.text] : [])).join('\n'));
      finishActivityTurn(this, turn);
    }
    this.bus.deliver(event, payload);
  }

  emitToThread<E extends RpcEventName>(threadId: ThreadId, event: E, payload: RpcEvents[E]): void {
    if (!this.bus.subscribed.has(threadId)) return;
    this.emit(event, payload);
  }

  thread(threadId: ThreadId): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) throw this.notFound('thread', threadId);
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

  setBackground(thread: Thread, tasks: BackgroundTask[]): void {
    thread.background = tasks;
    this.emit('thread.background', { threadId: thread.id, tasks: structuredClone(tasks) });
  }

  publishActivity(thread: Thread): void {
    this.emit('thread.activity', { threadId: thread.id, activity: structuredClone(thread.activity!) });
  }
}
