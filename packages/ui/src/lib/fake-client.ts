import {
  MESSAGE_PAGE,
  MESSAGE_PAGE_MAX,
  PROTOCOL_VERSION,
  RpcErrorCode,
  type Account,
  type AccountQuota,
  type AgentCommand,
  type PluginState,
  type PluginPool,
  type CoreInfo,
  type ImageAttachment,
  type Message,
  type MessageId,
  type MessagePart,
  type ModelInfo,
  type PairedSession,
  type PermissionRequest,
  type Principal,
  type QuestionAnswer,
  type QuestionRequest,
  type ProcessRecord,
  type Project,
  type ProviderInstallState,
  type ProviderSummary,
  type RpcEventName,
  type RpcEvents,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
  type SchedulerState,
  type Settings,
  type Thread,
  type ThreadId,
  type ThreadResources,
  type ThreadStatus,
  type ThreadSummary,
  type ToolDocument,
  type Turn,
  type Usage
} from '@boite/contracts';
import { decodedBytes } from './attachments';
import { RpcFailure, type ClientState, type EventHandler, type ObservableClient } from './client';

export interface FakeClientOptions {
  /** Milliseconds between two streamed chunks. Tests pass 0. */
  delayMs?: number;
  /** Seeds one thread of 400 messages, what `?fake=1&long=1` opens the list on. */
  long?: boolean;
}

const T0 = Date.UTC(2026, 8, 5, 9, 0, 0);
const DATA_DIR = 'C:\\Users\\you\\AppData\\Local\\boite2';

/** What the echo driver reports as its `/name` list, the same two commands. */
const ECHO_COMMANDS: AgentCommand[] = [
  { name: 'shout', description: 'The prompt back in capitals', hint: '<text>' },
  { name: 'whisper', description: 'The prompt back as it came', hint: null }
];
/** The one the fake acts on: `/shout <text>` comes back in capitals. */
const SHOUT = 'shout';

/** What `projects.files` names for any project of the seed: a small repository's tree. */
const FAKE_FILES = [
  'README.md',
  'package.json',
  'src/main.ts',
  'src/app.css',
  'src/App.svelte',
  'src/lib/store.svelte.ts',
  'src/lib/strings.ts',
  'src/lib/client.ts',
  'src/components/Composer.svelte',
  'src/components/Sidebar.svelte',
  'docs/development.md',
  'docs/providers.md',
  'tests/e2e/ui.test.ts'
];

/**
 * The core's ranking in short: the file's own name first, prefix over
 * substring, then the whole path, ties to the shorter path.
 */
function scoreFakeFile(query: string, path: string): number {
  const word = query.toLowerCase();
  if (word.length === 0) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (name.startsWith(word)) return 80;
  if (name.includes(word)) return 60;
  if (lower.includes(word)) return 40;
  return 0;
}

/** The managed provider of the seed: a release Boite downloads, 468 MB of it. */
const MANAGED_ID = 'antigravity';
const MANAGED_VERSION = 'agy_acp_server_1.1.1';
const MANAGED_ARCHIVE_BYTES = 468_238_392;
const MANAGED_EXE = `${DATA_DIR}\\agents\\${MANAGED_ID}\\current\\agy_acp_server.exe`;

/** The second one is already down, one version behind: that is the Update row. */
const UPDATABLE_ID = 'opencode';
const UPDATABLE_VERSION = '0.4.12';
const UPDATABLE_AVAILABLE = '0.5.0';
const UPDATABLE_ARCHIVE_BYTES = 41_268_224;

/** What one `providers.install` on that provider would fetch, and how big it is. */
const RELEASES: Record<string, { version: string; archiveBytes: number }> = {
  [MANAGED_ID]: { version: MANAGED_VERSION, archiveBytes: MANAGED_ARCHIVE_BYTES },
  [UPDATABLE_ID]: { version: UPDATABLE_AVAILABLE, archiveBytes: UPDATABLE_ARCHIVE_BYTES }
};
/** Sixteen steps of 120 ms: about two seconds of download, long enough to be seen. */
const INSTALL_STEPS = 16;
const INSTALL_STEP_MS = 120;

/** Where the core would put a worktree: `<parent>/.boite-worktrees/<repo>/<slug>` on `boite/<slug>`. */
function fakeWorktree(projectPath: string, title: string, branch?: string): { branch: string; path: string } {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'thread';
  const separator = projectPath.includes('\\') ? '\\' : '/';
  const parts = projectPath.split(/[\\/]/);
  const repo = parts.pop() ?? 'repo';
  const dir = branch === undefined ? slug : branch.replace(/^boite\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return {
    branch: branch ?? `boite/${slug}`,
    path: [...parts, '.boite-worktrees', repo, dir].join(separator)
  };
}

function toSummary(thread: Thread): ThreadSummary {
  const { messages: _messages, turns: _turns, ...rest } = thread;
  return { ...rest };
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: 0
  };
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsdEquivalent: (a.costUsdEquivalent ?? 0) + (b.costUsdEquivalent ?? 0)
  };
}

function chunkText(text: string, pieces: number): string[] {
  if (text.length === 0) return [''];
  const size = Math.max(1, Math.ceil(text.length / pieces));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const SPAWN_MARKER = /\[spawn:([^\]]+)\]/;

/** What `[tool-stream]` types one piece at a time before the parsed input lands. */
const STREAMED_TOOL_INPUT = '{"command":"echo streamed","description":"a streamed input"}';

/** The three tool documents, the same ones the core's echo driver produces. */
/** What the fake agent asks when a prompt mentions a question, echo's wording. */
const QUESTION_TEXT = 'Which shape should the echo take?';
const QUESTION_OPTIONS = [
  { id: 'short', label: 'Short', description: 'one line back' },
  { id: 'long', label: 'Long', description: 'the whole prompt back' }
];

const DIFF_PATH = 'src/app.ts';
const DIFF_OLD = 'export function boot() {\n  return start();\n}';
const DIFF_NEW = "export function boot() {\n  return start({ warm: true });\n  log('booted');\n}";
const DOC_TITLE = 'README.md';
const DOC_TEXT = [
  '# README',
  '- the first item',
  '- the second item',
  '```ts',
  'export const answer = 42;',
  '```'
].join('\n');
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** The questions the four-hundred-message thread repeats, so heights vary down the list. */
const LONG_ASKS = [
  'Where does the scheduler decide a turn may start?',
  'Read the descriptor loader and tell me what it refuses',
  'Why does the shell start its own core?',
  'What does the Job Object give us that a pid list does not?',
  'Show me the part of the journal that survives a crash'
];

/** The answers beside them, of deliberately uneven length. */
const LONG_ANSWERS = [
  'In `packages/core/src/scheduler.ts`: a turn leaves the queue when both caps hold, the global one and the one on its account.',
  [
    'The loader refuses four things, each with the file, the field and what was expected:',
    '',
    '- a `protocol` it does not know',
    '- a `roots` entry that resolves outside the descriptor directory',
    '- an `env` key it would have to invent a value for',
    '- a `login` block on a provider whose account is the default one',
    '',
    'Nothing is dropped in silence, which is the rule the whole module is written to.'
  ].join('\n'),
  'Because the window is a client. The core is the host, and the shell owns it through a `KILL_ON_JOB_CLOSE` job so closing the window never leaves an agent running.',
  'Exact start and exit events for every process a thread launched, grandchildren included, plus the CPU and the peak memory the kernel already counted. A pid list gives you a guess and a race.',
  [
    'The journal is SQLite in WAL mode, so the last committed write is what a restart reads:',
    '',
    '```ts',
    "db.run('PRAGMA journal_mode = WAL');",
    "db.run('PRAGMA synchronous = NORMAL');",
    '```',
    '',
    'A turn that was running when the core died comes back as `stopped`, never as `running`.'
  ].join('\n')
];

/** How long the fake agent takes to answer a probe, so the picker shows it reading. */
const PROBE_MS = 150;
/** How long the fake's `threads.retitle` takes: long enough for the menu to say it is writing. */
const RETITLE_DELAY_MS = 200;

/**
 * What the fake ACP agent lists in the `configOptions` of a `session/new`: its
 * own models, the descriptor's `default` first, and one reasoning scale that
 * belongs to the session rather than to a model.
 */
const PROBED_EFFORT = {
  levels: [
    { id: 'think', label: 'Think' },
    { id: 'think-hard', label: 'Think hard' }
  ],
  default: 'think'
};

/**
 * A real OpenCode answers with hundreds of models across a dozen prefixes (534
 * on the machine this was written on), so the fake answers with enough of them
 * to put the picker's model column past its search threshold.
 */
const PROBED_CATALOGUE: [string, string][] = [
  ['openrouter/anthropic/claude-sonnet-4-5', 'Claude Sonnet 4.5'],
  ['openrouter/anthropic/claude-haiku-4-5', 'Claude Haiku 4.5'],
  ['openrouter/openai/gpt-5-mini', 'GPT-5 Mini'],
  ['openrouter/google/gemini-3-pro', 'Gemini 3 Pro'],
  ['openrouter/meta-llama/llama-4-scout', 'Llama 4 Scout'],
  ['openrouter/deepseek/deepseek-v4', 'DeepSeek V4'],
  ['openrouter/qwen/qwen3-max', 'Qwen3 Max'],
  ['opencode/grok-code', 'Grok Code'],
  ['opencode/claude-sonnet-5', 'Claude Sonnet 5 zen'],
  ['opencode/gpt-5-codex', 'GPT-5 Codex zen'],
  ['opencode/kimi-k2', 'Kimi K2'],
  ['opencode/glm-4-7', 'GLM 4.7'],
  ['opencode/minimax-m2', 'MiniMax M2'],
  ['nvidia/nemotron-4-340b', 'Nemotron 4 340B'],
  ['nvidia/llama-3-3-nemotron-super', 'Llama 3.3 Nemotron Super'],
  ['nvidia/mistral-nemo-12b', 'Mistral Nemo 12B'],
  ['nvidia/deepseek-r2', 'DeepSeek R2'],
  ['nvidia/qwen3-coder-480b', 'Qwen3 Coder 480B'],
  ['nvidia/gpt-oss-120b', 'GPT-OSS 120B'],
  ['nvidia/phi-4-reasoning', 'Phi 4 Reasoning']
];

const PROBED_MODELS: ModelInfo[] = [
  { id: 'default', name: 'OpenCode default', default: false, effort: PROBED_EFFORT },
  { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: PROBED_EFFORT },
  { id: 'openai/gpt-5-codex', name: 'GPT-5 Codex', default: false, effort: PROBED_EFFORT },
  ...PROBED_CATALOGUE.map(([id, name]): ModelInfo => ({ id, name, default: false, effort: PROBED_EFFORT }))
];

const PROBE_PROVIDERS: Pick<ProviderSummary, 'id' | 'name' | 'protocol' | 'login'>[] = [
  { id: 'codex', name: 'Codex', protocol: 'codex-appserver', login: { kind: 'command' } },
  { id: 'pi', name: 'pi', protocol: 'pi', login: false },
  { id: 'grok', name: 'Grok', protocol: 'acp', login: { kind: 'command' } }
];

/**
 * The whole core in memory, contract-accurate: what `vite dev` uses behind
 * `?fake=1` and what every test runs against.
 */
export class FakeClient implements ObservableClient {
  #state: ClientState = 'idle';
  #handlers = new Map<string, Set<(payload: unknown) => void>>();
  #stateHandlers = new Set<(state: ClientState) => void>();
  #subscribed = new Set<ThreadId>();

  #projects: Project[] = [];
  #providers: ProviderSummary[] = [];
  /** Where each managed install stood before the running one started, for a cancel. */
  #installBefore = new Map<string, ProviderInstallState>();
  #accounts: Account[] = [];
  #threads = new Map<ThreadId, Thread>();
  #processes: ProcessRecord[] = [];
  #usage = new Map<ThreadId, Usage>();
  #settings: Settings;
  #quotaEnabled: Record<string, boolean> = {};
  #plugin: PluginState = { id: 'kebacc-switcher', name: 'kebacc-switcher', version: null, availableVersion: '2.0.1', status: 'not-installed', progress: 0, error: null };
  #pluginPools: PluginPool[] = ['claude', 'codex', 'antigravity'].map((provider) => ({ provider, accounts: [
    { email: 'work@example.com', active: true, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 32, resetsAt: null }, { id: 'sevenDay', label: 'Weekly', usedPercent: 74, resetsAt: null }] },
    { email: 'personal@example.com', active: false, checkedSecondsAgo: 10, windows: [{ id: 'fiveHour', label: '5 hours', usedPercent: 8, resetsAt: null }] },
  ] }));
  #scheduler: SchedulerState;
  #core: CoreInfo;
  /** One phone already paired, so the devices list has a row to revoke. */
  #sessions: PairedSession[] = [
    { id: 'ses-phone', client: { name: 'pwa', version: '2.0.0-beta.1' }, createdAt: T0, lastSeenAt: T0 + 600_000, current: false }
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
  #delayMs: number;
  #long: boolean;

  constructor(options: FakeClientOptions = {}) {
    this.#delayMs = options.delayMs ?? 18;
    this.#long = options.long ?? false;
    this.#settings = {
      maxConcurrentTurns: 6,
      perAccountConcurrency: 2,
      warmProcessMinutes: 5,
      listenOnLan: false,
      agentCpuCapPercent: 75,
      threadMemoryCapMb: 0,
      focusGuard: true,
      muteAgents: true
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

  /** The fake is the desktop: the owner, who can pair a phone. */
  get principal(): Principal | null {
    return this.#state === 'ready' ? 'owner' : null;
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
    this.#setState('closed');
  }

  async call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.#state !== 'ready' && method !== 'hello') {
      throw new RpcFailure({ code: RpcErrorCode.Internal, message: 'not connected' });
    }
    await this.#tick();
    return await this.#dispatch(method, params) as RpcResult<M>;
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

  async #dispatch(method: RpcMethodName, rawParams: unknown): Promise<unknown> {
    switch (method) {
      case 'quotas.configure': {
        const params = rawParams as RpcParams<'quotas.configure'>;
        this.#quotaEnabled[params.accountId] = params.enabled;
        const rows = this.#quotas(); this.#emit('quotas.updated', rows); return rows;
      }
      case 'quotas.list': return this.#quotas();
      case 'plugins.list': return [structuredClone(this.#plugin)];
      case 'plugins.install': {
        this.#plugin = { ...this.#plugin, status: 'installed', version: '2.0.1', progress: 100 };
        this.#emit('plugins.updated', structuredClone(this.#plugin)); return structuredClone(this.#plugin);
      }
      case 'plugins.cancel': return structuredClone(this.#plugin);
      case 'plugins.uninstall': {
        this.#plugin = { ...this.#plugin, status: 'not-installed', version: null, progress: 0 };
        this.#emit('plugins.updated', structuredClone(this.#plugin)); return structuredClone(this.#plugin);
      }
      case 'plugins.accounts': return structuredClone(this.#pluginPools);
      case 'plugins.accountAction': {
        const params = rawParams as RpcParams<'plugins.accountAction'>;
        const pool = this.#pluginPools.find((pool) => pool.provider === params.provider);
        if (pool && params.action === 'switch') for (const account of pool.accounts) account.active = account.email === params.email;
        if (pool && params.action === 'remove') pool.accounts = pool.accounts.filter((a) => a.email !== params.email);
        return structuredClone(this.#pluginPools);
      }
      case 'hello':
        return { core: this.#core, principal: 'owner' };
      case 'pairing.grant': {
        const grant = `fake-grant-${++this.#seq}`;
        return { url: `http://192.168.1.20:8777/?grant=${grant}`, grant, expiresAt: this.#now() + 10 * 60 * 1000 };
      }
      case 'sessions.list':
        return structuredClone(this.#sessions);
      case 'sessions.revoke': {
        const params = rawParams as RpcParams<'sessions.revoke'>;
        if (!this.#sessions.some((session) => session.id === params.sessionId)) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `unknown session ${params.sessionId}` });
        }
        this.#sessions = this.#sessions.filter((session) => session.id !== params.sessionId);
        this.#emit('sessions.updated', { sessionId: params.sessionId, state: 'revoked' });
        return { ok: true };
      }

      case 'projects.list':
        return structuredClone(this.#projects);
      case 'projects.add': {
        const params = rawParams as RpcParams<'projects.add'>;
        const project: Project = {
          id: `p-${++this.#seq}`,
          name: params.name ?? params.path.split(/[\\/]/).filter(Boolean).pop() ?? params.path,
          path: params.path,
          createdAt: this.#now()
        };
        this.#projects.push(project);
        this.#emit('project.added', structuredClone(project));
        return structuredClone(project);
      }
      case 'projects.remove': {
        const params = rawParams as RpcParams<'projects.remove'>;
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
      }
      case 'projects.files': {
        const params = rawParams as RpcParams<'projects.files'>;
        if (!this.#projects.some((p) => p.id === params.projectId)) {
          throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown project ${params.projectId}` });
        }
        const limit = Math.max(1, Math.min(200, params.limit ?? 50));
        const scored = FAKE_FILES.map((path) => ({ path, score: scoreFakeFile(params.query, path) }))
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
        return { files: scored.slice(0, limit).map((entry) => entry.path), total: scored.length, capped: false };
      }

      case 'providers.list':
        return { loaded: structuredClone(this.#providers), rejected: [] };
      case 'providers.reload': {
        const result = { loaded: structuredClone(this.#providers), rejected: [] };
        this.#emit('providers.updated', structuredClone(result));
        return result;
      }
      case 'providers.probe': {
        const params = rawParams as RpcParams<'providers.probe'>;
        return this.#probe(params.providerId, params.accountId);
      }
      case 'providers.install': {
        const params = rawParams as RpcParams<'providers.install'>;
        return this.#startInstall(params.providerId);
      }
      case 'providers.installCancel': {
        const params = rawParams as RpcParams<'providers.installCancel'>;
        return this.#cancelInstall(params.providerId, params.operationId);
      }
      case 'providers.uninstall': {
        const params = rawParams as RpcParams<'providers.uninstall'>;
        return this.#uninstall(params.providerId);
      }
      case 'providers.dryRun': {
        const params = rawParams as RpcParams<'providers.dryRun'>;
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
      }

      case 'accounts.list':
        return structuredClone(this.#accounts);
      case 'accounts.add': {
        const params = rawParams as RpcParams<'accounts.add'>;
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
      }
      case 'accounts.remove': {
        const params = rawParams as RpcParams<'accounts.remove'>;
        if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
        const referenced = [...this.#threads.values()].find((t) => t.accountId === params.accountId);
        if (referenced) {
          throw new RpcFailure({ code: RpcErrorCode.Refused, message: `account ${params.accountId} is used by thread ${referenced.id}` });
        }
        this.#cancelLogin(params.accountId);
        this.#accounts = this.#accounts.filter((a) => a.id !== params.accountId);
        this.#emit('accounts.removed', { accountId: params.accountId });
        return { ok: true };
      }
      case 'accounts.check': {
        const params = rawParams as RpcParams<'accounts.check'>;
        const account = this.#accounts.find((a) => a.id === params.accountId);
        if (!account) throw this.#notFound('account', params.accountId);
        account.status = account.isolationDir === null ? 'ok' : 'unauthenticated';
        account.identity = account.status === 'ok' ? 'you@example.com' : null;
        this.#emit('accounts.updated', structuredClone(account));
        return structuredClone(account);
      }
      case 'accounts.login': {
        const params = rawParams as RpcParams<'accounts.login'>;
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
      }
      case 'accounts.logins':
        return structuredClone([...this.#logins.values()]);
      case 'accounts.loginCancel': {
        const params = rawParams as RpcParams<'accounts.loginCancel'>;
        if (!this.#accounts.some((a) => a.id === params.accountId)) throw this.#notFound('account', params.accountId);
        this.#cancelLogin(params.accountId);
        return { ok: true };
      }
      case 'accounts.loginInput': {
        const params = rawParams as RpcParams<'accounts.loginInput'>;
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
      }

      case 'threads.list': {
        const params = rawParams as RpcParams<'threads.list'>;
        return [...this.#threads.values()]
          .filter((t) => (params.projectId ? t.projectId === params.projectId : true))
          .filter((t) => (params.includeArchived ? true : !t.archived))
          .map((t) => structuredClone(toSummary(t)));
      }
      case 'threads.create': {
        const params = rawParams as RpcParams<'threads.create'>;
        const project = this.#projects.find((p) => p.id === params.projectId);
        if (!project) throw this.#notFound('project', params.projectId);
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
          cwd: placed?.path ?? params.cwd ?? project.path,
          branch: placed?.branch ?? null,
          permissionMode: params.permissionMode ?? 'default',
          status: 'idle',
          unread: false,
          archived: false,
          pinned: false,
          sessionId: null,
          load: null,
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
      }
      case 'threads.get': {
        const params = rawParams as RpcParams<'threads.get'>;
        const thread = this.#thread(params.threadId);
        const page = this.#page(thread.messages, thread.messages.length, MESSAGE_PAGE);
        return structuredClone({ ...thread, messages: page.messages, messagesBefore: page.before });
      }
      case 'messages.list': {
        const params = rawParams as RpcParams<'messages.list'>;
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
        return structuredClone(this.#page(thread.messages, at, limit));
      }
      case 'threads.update': {
        const params = rawParams as RpcParams<'threads.update'>;
        const thread = this.#thread(params.threadId);
        if (params.title !== undefined) {
          thread.title = params.title;
          thread.titleSource = 'user';
        }
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.effort = params.effort;
        if (params.permissionMode !== undefined) thread.permissionMode = params.permissionMode;
        return this.#touch(thread);
      }
      case 'threads.retitle': {
        const params = rawParams as RpcParams<'threads.retitle'>;
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
      }
      case 'threads.archive': {
        const params = rawParams as RpcParams<'threads.archive'>;
        const thread = this.#thread(params.threadId);
        thread.archived = params.archived ?? true;
        if (thread.archived) await this.#stopTurn(thread.id);
        return this.#touch(thread);
      }
      case 'threads.pin': {
        const params = rawParams as RpcParams<'threads.pin'>;
        const thread = this.#thread(params.threadId);
        const pinned = params.pinned ?? true;
        if (thread.pinned === pinned) return structuredClone(toSummary(thread));
        thread.pinned = pinned;
        return this.#touch(thread);
      }
      case 'threads.markRead': {
        const params = rawParams as RpcParams<'threads.markRead'>;
        const thread = this.#thread(params.threadId);
        thread.unread = false;
        this.#touch(thread);
        return { ok: true };
      }
      case 'threads.subscribe': {
        const params = rawParams as RpcParams<'threads.subscribe'>;
        this.#subscribed.add(params.threadId);
        return { ok: true };
      }
      case 'threads.unsubscribe': {
        const params = rawParams as RpcParams<'threads.unsubscribe'>;
        this.#subscribed.delete(params.threadId);
        return { ok: true };
      }

      case 'turns.start': {
        const params = rawParams as RpcParams<'turns.start'>;
        return this.#startTurn(params.threadId, params.prompt, params.attachments ?? []);
      }
      case 'turns.stop': {
        const params = rawParams as RpcParams<'turns.stop'>;
        return { stopped: await this.#stopTurn(params.threadId) };
      }

      case 'permissions.list': {
        const params = rawParams as RpcParams<'permissions.list'>;
        const requests = [...this.#pendingPermissions.values()]
          .map((pending) => pending.request)
          .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
          .sort((a, b) => a.createdAt - b.createdAt);
        return structuredClone(requests);
      }

      case 'permissions.answer': {
        const params = rawParams as RpcParams<'permissions.answer'>;
        const pending = this.#pendingPermissions.get(params.requestId);
        if (!pending) throw this.#notFound('permission request', params.requestId);
        this.#pendingPermissions.delete(params.requestId);
        pending.resolve(params.decision);
        return { ok: true };
      }

      case 'questions.list': {
        const params = rawParams as RpcParams<'questions.list'>;
        const requests = [...this.#pendingQuestions.values()]
          .map((pending) => pending.request)
          .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
          .sort((a, b) => a.createdAt - b.createdAt);
        return structuredClone(requests);
      }

      case 'questions.answer': {
        const params = rawParams as RpcParams<'questions.answer'>;
        const pending = this.#pendingQuestions.get(params.questionId);
        if (!pending) throw this.#notFound('question', params.questionId);
        this.#pendingQuestions.delete(params.questionId);
        const text = params.text ?? '';
        const answer: QuestionAnswer =
          text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
        pending.resolve(answer);
        return { ok: true };
      }

      case 'trace.get': {
        const params = rawParams as RpcParams<'trace.get'>;
        const rows = this.#processes
          .filter((p) => p.threadId === params.threadId)
          .sort((a, b) => b.startedAt - a.startedAt);
        return structuredClone(params.limit ? rows.slice(0, params.limit) : rows);
      }
      case 'resources.list':
        return structuredClone(this.#resources());
      case 'resources.killTree': {
        const params = rawParams as RpcParams<'resources.killTree'>;
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
      }

      case 'scheduler.get':
        return structuredClone(this.#scheduler);
      case 'usage.get': {
        const params = rawParams as RpcParams<'usage.get'>;
        const byThread: Record<ThreadId, Usage> = {};
        let total = emptyUsage();
        for (const [threadId, usage] of this.#usage) {
          if (params.threadId && params.threadId !== threadId) continue;
          byThread[threadId] = { ...usage };
          total = addUsage(total, usage);
        }
        return { byThread, total };
      }

      case 'settings.get':
        return { ...this.#settings };
      case 'keybindings.get':
        // A file with one moved chord, one taken away, and one line the core refused.
        return {
          path: `${DATA_DIR}\\keybindings.json`,
          bindings: { 'theme-light': 'mod+shift+l', panel: null },
          errors: ['keybindings.json: "trace": "t" has no modifier: a chord needs mod, ctrl, alt or meta before its key']
        };
      case 'settings.set': {
        const params = rawParams as RpcParams<'settings.set'>;
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
      }

      default: {
        const unreachable: never = method;
        throw new RpcFailure({
          code: RpcErrorCode.MethodNotFound,
          message: `unknown method ${String(unreachable)}`
        });
      }
    }
  }

  #quotas(): AccountQuota[] {
    return this.#accounts.map((account, index) => ({
      accountId: account.id, providerId: account.providerId, providerName: this.#providers.find((p) => p.id === account.providerId)?.name ?? account.providerId,
      label: account.label, enabled: this.#quotaEnabled[account.id] !== false,
      status: this.#quotaEnabled[account.id] === false ? 'disabled' : 'ready',
      checkedAt: Date.now(), error: null,
      windows: this.#quotaEnabled[account.id] === false ? [] : [
        { id: 'primary', label: '5 hours', usedPercent: index === 0 ? 32 : 87, resetsAt: Date.now() + 2 * 3600_000 },
        { id: 'secondary', label: 'Weekly', usedPercent: 61, resetsAt: Date.now() + 3 * 86400_000 },
      ],
    }));
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async #stopTurn(threadId: ThreadId): Promise<boolean> {
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

  #startTurn(threadId: ThreadId, prompt: string, attachments: ImageAttachment[] = []): Turn {
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
      error: null
    };
    thread.turns.push(turn);

    const user: Message = {
      id: `m-${++this.#seq}`,
      threadId,
      turnId: turn.id,
      role: 'user',
      // The images ride after the text, the order the core journals them in.
      parts: [
        { type: 'text', text: prompt },
        ...attachments.map((attachment): MessagePart => ({
          type: 'image',
          mimeType: attachment.mimeType,
          data: attachment.data,
          alt: attachment.name
        }))
      ],
      state: 'complete',
      createdAt: at
    };
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
    attachments: ImageAttachment[] = []
  ): Promise<void> {
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
            `[image ${attachment.mimeType}, ${decodedBytes(attachment.data)} bytes${
              attachment.name === null ? '' : `, ${attachment.name}`
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

    this.#inFlight.delete(thread.id);
    thread.status = 'idle';
    thread.unread = !this.#subscribed.has(thread.id);
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

  #emit<E extends RpcEventName>(event: E, payload: RpcEvents[E]): void {
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
    const dynamic = ['acp', 'codex-appserver', 'pi'].includes(provider.protocol);
    if (dynamic && !provider.available) {
      throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${provider.name} is not available on this machine` });
    }
    let models = structuredClone(provider.models);
    if (dynamic) {
      models = provider.id === UPDATABLE_ID ? structuredClone(PROBED_MODELS) : [
        ...models,
        { id: `${provider.id}-demo`, name: `${provider.name} demo model`, default: false }
      ];
      await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
    }
    const probedAt = this.#now();
    this.#emit('providers.probed', { providerId, accountId, models: structuredClone(models), probedAt });
    return { models, probedAt };
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
    provider.executable = provider.id === MANAGED_ID ? MANAGED_EXE : provider.executable;
    this.#setInstall(provider, {
      state: 'installed',
      version: release.version,
      installedAt: this.#now(),
      available: release.version
    });
    this.#emit('providers.updated', { loaded: structuredClone(this.#providers), rejected: [] });
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
      { id: 'p-boite', name: 'boite', path: 'D:\\Dev\\Collab\\boite', createdAt: T0 },
      { id: 'p-brain', name: 'brain', path: 'D:\\Dev\\brain', createdAt: T0 }
    ];

    this.#providers = [
      {
        id: 'claude',
        name: 'Claude',
        shortName: 'Claude',
        protocol: 'claude-sdk',
        login: { kind: 'command' },
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: 'C:\\Users\\you\\.local\\bin\\claude.exe',
        models: [
          { id: 'claude-fable-5-1', name: 'Claude Fable 5.1', badge: 'new', effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-opus-5', name: 'Claude Opus 5', effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', default: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' },
                { id: 'xhigh', label: 'Extra high' },
                { id: 'max', label: 'Max' },
                { id: 'ultrathink', label: 'Ultrathink', description: 'Extended thinking, asked for in the prompt' }
              ],
              default: 'high'
            } },
          { id: 'claude-fable-5', name: 'Claude Fable 5', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', legacy: true, effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'medium', label: 'Medium' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            } },
          { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', legacy: true }
        ],
        install: null,
        capabilities: {
          approvals: true,
          hooks: true,
          checkpoint: true,
          images: true,
          planMode: true,
          resume: true
        }
      },
      {
        id: 'echo',
        name: 'Echo',
        shortName: 'Echo',
        protocol: 'echo',
        login: false,
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: null,
        models: [
          {
            id: 'echo-1',
            name: 'Echo',
            default: true,
            effort: {
              levels: [
                { id: 'low', label: 'Low' },
                { id: 'high', label: 'High' }
              ],
              default: 'high'
            }
          }
        ],
        install: null,
        // The shipped echo descriptor reads images too: the fake agent names
        // back what it was sent, which is what the attachment capture proves.
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: true,
          planMode: false,
          resume: true
        }
      },
      {
        id: UPDATABLE_ID,
        name: 'OpenCode',
        shortName: 'OpenCode',
        protocol: 'acp',
        login: { kind: 'command' },
        alwaysIsolated: false,
        source: 'shipped',
        available: true,
        executable: 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.exe',
        // One model in the descriptor: the agent owns the rest, and a probe reads them.
        models: [{ id: 'default', name: 'OpenCode default', default: true }],
        // Its files are down and one version behind: the Providers page offers Update.
        install: {
          state: 'installed',
          version: UPDATABLE_VERSION,
          installedAt: T0,
          available: UPDATABLE_AVAILABLE
        },
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: false,
          planMode: false,
          resume: true
        }
      },
      {
        id: MANAGED_ID,
        name: 'Antigravity',
        shortName: 'Antigravity',
        protocol: 'acp',
        login: { kind: 'acp' },
        alwaysIsolated: true,
        source: 'shipped',
        // Nothing runs until the release lands: the picker row offers the download.
        available: false,
        executable: null,
        models: [{ id: 'default', name: 'Antigravity default', default: true }],
        install: {
          state: 'absent',
          version: MANAGED_VERSION,
          archiveBytes: MANAGED_ARCHIVE_BYTES
        },
        capabilities: {
          approvals: true,
          hooks: false,
          checkpoint: false,
          images: false,
          planMode: false,
          resume: true
        }
      }
    ];
    this.#providers.push(...PROBE_PROVIDERS.map((provider): ProviderSummary => ({
      ...provider,
      shortName: provider.name,
      source: 'shipped',
      available: true,
      executable: `${DATA_DIR}\\demo\\${provider.id}.exe`,
      models: [{ id: 'default', name: `${provider.name} default`, default: true }],
      capabilities: {
        approvals: provider.protocol !== 'pi', hooks: false, checkpoint: false,
        images: false, planMode: provider.protocol !== 'pi', resume: true
      },
      install: null,
      alwaysIsolated: false
    })));
    this.#accounts = [
      {
        id: 'a-echo',
        providerId: 'echo',
        label: 'Echo',
        isolationDir: `${DATA_DIR}\\accounts\\a-echo`,
        status: 'ok',
        identity: 'echo',
        createdAt: T0
      },
      {
        id: 'a-antigravity',
        providerId: MANAGED_ID,
        label: 'Antigravity',
        isolationDir: `${DATA_DIR}\\accounts\\a-antigravity`,
        // A managed provider is signed into from the Accounts page, once its
        // files are down: nothing on this machine has logged it in yet.
        status: 'unauthenticated',
        identity: null,
        createdAt: T0
      },
      {
        id: 'a-claude-main',
        providerId: 'claude',
        label: 'Default login',
        isolationDir: null,
        status: 'ok',
        identity: 'you@example.com',
        createdAt: T0
      },
      {
        id: 'a-claude-side',
        providerId: 'claude',
        label: 'Second seat',
        isolationDir: `${DATA_DIR}\\accounts\\a-claude-side`,
        status: 'unauthenticated',
        identity: null,
        createdAt: T0
      },
      {
        id: 'a-opencode',
        providerId: 'opencode',
        label: 'Default',
        isolationDir: null,
        status: 'ok',
        identity: 'you@example.com',
        createdAt: T0
      }
    ];

    this.#accounts.push(...PROBE_PROVIDERS.map((provider): Account => ({
      id: `a-${provider.id}`,
      providerId: provider.id,
      label: 'Default',
      isolationDir: null,
      status: 'ok',
      identity: 'you@example.com',
      createdAt: T0
    })));

    const base = {
      providerId: 'echo',
      accountId: 'a-echo',
      model: 'echo-1',
      effort: null,
      permissionMode: 'default' as const,
      archived: false,
      pinned: false,
      branch: null,
      titleSource: 'prompt' as const,
      // A stored thread is the whole record; `threads.get` is what pages it.
      messagesBefore: null,
      commands: []
    };

    const finished: Thread = {
      ...base,
      id: 't-trace',
      projectId: 'p-boite',
      title: 'Finish the trace tab',
      cwd: 'D:\\Dev\\Collab\\boite',
      status: 'idle',
      unread: false,
      sessionId: 'sess-trace',
      load: null,
      createdAt: T0,
      updatedAt: T0 + 60_000,
      turns: [
        {
          id: 'turn-seed-1',
          threadId: 't-trace',
          status: 'done',
          queuedAt: T0,
          startedAt: T0,
          finishedAt: T0 + 41_000,
          usage: {
            inputTokens: 1840,
            outputTokens: 520,
            cacheReadTokens: 12_400,
            cacheWriteTokens: 900,
            costUsdEquivalent: 0.041
          },
          error: null
        }
      ],
      messages: [
        {
          id: 'm-1',
          threadId: 't-trace',
          turnId: 'turn-seed-1',
          role: 'user',
          parts: [{ type: 'text', text: 'What does the trace tab need from the core?' }],
          state: 'complete',
          createdAt: T0
        },
        {
          id: 'm-2',
          threadId: 't-trace',
          turnId: 'turn-seed-1',
          role: 'assistant',
          parts: [
            {
              type: 'thinking',
              text: 'The table wants a row per process, so the question is what procs already reports and what the panel would have to ask for on top. Start with trace.get.'
            },
            {
              type: 'text',
              text: 'It needs trace.get for the table and the TraceCapability note above it. Let me look at what procs already reports.'
            },
            {
              type: 'tool',
              toolId: 'tool-seed-1',
              name: 'Grep',
              input: { pattern: 'process.started', path: 'packages/core/src' },
              output: 'packages/core/src/procs.ts:88\npackages/core/src/trace.ts:20',
              status: 'done'
            },
            {
              type: 'text',
              text: 'Both events carry the pid, the exe, the CPU time and the peak memory, so the table can be filled without a second call.'
            }
          ],
          state: 'complete',
          createdAt: T0 + 20_000
        }
      ]
    };

    const running: Thread = {
      ...base,
      id: 't-scheduler',
      projectId: 'p-boite',
      title: 'Port the scheduler',
      // The one seeded thread in its own worktree: what the header badge is looked at on.
      cwd: 'D:\\Dev\\Collab\\.boite-worktrees\\boite\\port-the-scheduler',
      branch: 'boite/port-the-scheduler',
      // Waiting on a question nobody has answered, the same reason as `t-bench`
      // and its permission: a page that loads now draws the card from the list.
      status: 'waiting',
      unread: false,
      sessionId: 'sess-scheduler',
      load: { processes: 2, cpuPercent: 34, memoryBytes: 412 * 1024 * 1024 },
      createdAt: T0 + 100_000,
      updatedAt: T0 + 180_000,
      turns: [
        {
          id: 'turn-seed-2',
          threadId: 't-scheduler',
          status: 'running',
          queuedAt: T0 + 170_000,
          startedAt: T0 + 170_500,
          finishedAt: null,
          usage: null,
          error: null
        }
      ],
      messages: [
        {
          id: 'm-3',
          threadId: 't-scheduler',
          turnId: 'turn-seed-2',
          role: 'user',
          parts: [{ type: 'text', text: 'Count turns, never threads. Start with the caps.' }],
          state: 'complete',
          createdAt: T0 + 170_000
        },
        {
          id: 'm-4',
          threadId: 't-scheduler',
          turnId: 'turn-seed-2',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Reading the current caps and the queue order' },
            {
              type: 'question',
              questionId: 'qst-seed-1',
              text: QUESTION_TEXT,
              options: QUESTION_OPTIONS,
              allowText: true,
              multiple: false,
              answer: null
            }
          ],
          state: 'streaming',
          createdAt: T0 + 171_000
        }
      ]
    };

    // Its turn is stopped on a permission nobody has answered, which is what a
    // page that loads now shows without ever having seen `permission.requested`.
    const waiting: Thread = {
      ...base,
      id: 't-bench',
      projectId: 'p-boite',
      title: 'Bench against legacy',
      cwd: 'D:\\Dev\\Collab\\boite',
      status: 'waiting',
      unread: false,
      sessionId: 'sess-bench',
      load: null,
      createdAt: T0 + 200_000,
      updatedAt: T0 + 200_000,
      turns: [
        {
          id: 'turn-seed-3',
          threadId: 't-bench',
          status: 'running',
          queuedAt: T0 + 200_000,
          startedAt: T0 + 200_500,
          finishedAt: null,
          usage: null,
          error: null
        }
      ],
      messages: [
        {
          id: 'm-5',
          threadId: 't-bench',
          turnId: 'turn-seed-3',
          role: 'user',
          parts: [{ type: 'text', text: 'Fifty echo threads, RSS and throughput.' }],
          state: 'complete',
          createdAt: T0 + 200_000
        },
        {
          id: 'm-8',
          threadId: 't-bench',
          turnId: 'turn-seed-3',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Writing the run script before the fifty threads go out.' },
            { type: 'permission', requestId: 'req-seed-1', toolName: 'Write', decision: null }
          ],
          state: 'streaming',
          createdAt: T0 + 201_000
        }
      ]
    };

    const unread: Thread = {
      ...base,
      id: 't-descriptors',
      projectId: 'p-brain',
      title: 'Review the descriptor loader',
      cwd: 'D:\\Dev\\brain',
      // The most recent thread, so this is the one a boot opens: it has already
      // run a turn, so the echo agent has already named what it takes.
      commands: structuredClone(ECHO_COMMANDS),
      status: 'idle',
      unread: true,
      sessionId: 'sess-descriptors',
      load: null,
      createdAt: T0 + 300_000,
      updatedAt: T0 + 340_000,
      turns: [
        {
          id: 'turn-seed-4',
          threadId: 't-descriptors',
          status: 'done',
          queuedAt: T0 + 300_000,
          startedAt: T0 + 300_000,
          finishedAt: T0 + 340_000,
          usage: {
            inputTokens: 640,
            outputTokens: 210,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsdEquivalent: 0.008
          },
          error: null
        }
      ],
      messages: [
        {
          id: 'm-6',
          threadId: 't-descriptors',
          turnId: 'turn-seed-4',
          role: 'user',
          parts: [{ type: 'text', text: 'Does an unknown field refuse the file?' }],
          state: 'complete',
          createdAt: T0 + 300_000
        },
        {
          id: 'm-7',
          threadId: 't-descriptors',
          turnId: 'turn-seed-4',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'It does, with the file, the field and what was expected. One case is still silent: a roots entry that resolves outside the descriptor directory.'
            }
          ],
          state: 'complete',
          createdAt: T0 + 320_000
        }
      ]
    };

    for (const thread of [finished, running, waiting, unread]) this.#threads.set(thread.id, thread);
    if (this.#long) {
      const long = this.#longThread();
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

  /**
   * Four hundred messages of uneven height in one thread: what the windowed
   * list is looked at on, behind `?fake=1&long=1`.
   */
  #longThread(): Thread {
    const messages: Message[] = [];
    for (let index = 0; index < 400; index += 1) {
      const at = T0 + 400_000 + index * 1000;
      messages.push(
        index % 2 === 0
          ? {
              id: `m-long-${index}`,
              threadId: 't-long',
              turnId: 'turn-long',
              role: 'user',
              parts: [
                {
                  type: 'text',
                  text: `${LONG_ASKS[(index / 2) % LONG_ASKS.length] ?? ''} (${index})`
                }
              ],
              state: 'complete',
              createdAt: at
            }
          : {
              id: `m-long-${index}`,
              threadId: 't-long',
              turnId: 'turn-long',
              role: 'assistant',
              parts: [
                {
                  type: 'text',
                  text: LONG_ANSWERS[((index - 1) / 2) % LONG_ANSWERS.length] ?? ''
                }
              ],
              state: 'complete',
              createdAt: at
            }
      );
    }
    return {
      id: 't-long',
      projectId: 'p-boite',
      providerId: 'echo',
      accountId: 'a-echo',
      model: 'echo-1',
      effort: null,
      permissionMode: 'default',
      archived: false,
      pinned: false,
      title: 'Four hundred messages',
      titleSource: 'prompt',
      cwd: 'D:\\Dev\\Collab\\boite',
      branch: null,
      status: 'idle',
      unread: false,
      sessionId: 'sess-long',
      load: null,
      createdAt: T0 + 400_000,
      updatedAt: T0 + 800_000,
      messagesBefore: null,
      commands: [],
      turns: [
        {
          id: 'turn-long',
          threadId: 't-long',
          status: 'done',
          queuedAt: T0 + 400_000,
          startedAt: T0 + 400_000,
          finishedAt: T0 + 800_000,
          usage: {
            inputTokens: 41_200,
            outputTokens: 18_400,
            cacheReadTokens: 210_000,
            cacheWriteTokens: 12_000,
            costUsdEquivalent: 1.24
          },
          error: null
        }
      ],
      messages
    };
  }
}
