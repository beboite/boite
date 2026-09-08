/**
 * Boite 2 wire contract: the JSON-RPC methods and events between the core
 * (the host process that runs the agents) and its clients (the desktop shell,
 * the phone PWA, tests, benches).
 *
 * The core is the only side that executes anything. Clients drive it over an
 * authenticated WebSocket. This file is the whole vocabulary; a method or an
 * event that is not here does not exist.
 */

export const PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Identifiers. All opaque strings minted by the core.
// ---------------------------------------------------------------------------

export type ProjectId = string;
export type ThreadId = string;
export type TurnId = string;
export type MessageId = string;
export type AccountId = string;
export type ProviderId = string;
export type RequestId = string;

/** Milliseconds since the Unix epoch. */
export type Timestamp = number;

// ---------------------------------------------------------------------------
// Providers: one JSON descriptor per provider, shipped or user-supplied.
// ---------------------------------------------------------------------------

export type Protocol = 'claude-sdk' | 'codex-appserver' | 'opencode' | 'pi' | 'acp' | 'echo';

export type Os = 'windows' | 'linux' | 'macos';

export interface ExecutableCandidate {
  /** Where to look, in order. The user override always wins over all of these. */
  kind: 'path' | 'file' | 'registry' | 'acp-registry';
  value: string;
}

export interface OsProfile {
  /** The provider is offered only when one of these resolves. */
  detect: { command?: string; file?: string };
  executable: ExecutableCandidate[];
  launch?: { args?: string[] };
  /**
   * Environment that makes one account blind to the others. Values may use
   * `{isolationDir}`, replaced by the account's own directory.
   */
  isolation: Record<string, string>;
  /** Process names the core closes when an account is removed. */
  close?: { processes?: string[] };
}

export interface ProviderAuth {
  kind: 'oauth-cli' | 'api-key' | 'none';
  /** Files inside the isolation directory that carry the login. */
  session?: string[];
  /** Where the account identity is read from, and the shape it must have. */
  identity?: { source: { file: string; field: string } | { command: string[] }; format: string };
}

/**
 * How the provider's CLI logs one account in. The core runs it under the
 * account's isolation directory and streams its output back as
 * `account.login`; the user answers a prompt with `accounts.loginInput`.
 */
export interface ProviderLogin {
  /** The executable and its arguments. Never empty. */
  command: string[];
  /** Extra environment for the login process. Values may use `{isolationDir}`. */
  env?: Record<string, string>;
}

/** One step of a model's reasoning effort scale, as the descriptor spells it. */
export interface EffortLevel {
  id: string;
  label: string;
  description?: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  default?: boolean;
  /** Still accepted by the provider, folded away in the picker. */
  legacy?: boolean;
  /** A small mark next to the name in the picker. */
  badge?: 'new';
  /** Reasoning effort this model offers. A model without it has no effort control. */
  effort?: { levels: EffortLevel[]; default: string };
}

export interface ProviderCapabilities {
  approvals: boolean;
  hooks: boolean;
  checkpoint: boolean;
  images: boolean;
  planMode: boolean;
  resume: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  schemaVersion: 1;
  name: string;
  shortName: string;
  protocol: Protocol;
  /** Every path the engine reads or writes for this provider must fall under one of these. */
  roots: string[];
  profiles: Partial<Record<Os, OsProfile>>;
  auth: ProviderAuth;
  /** Absent when the provider has no way to log an account in from Boite. */
  login?: ProviderLogin;
  models: ModelInfo[];
  capabilities: ProviderCapabilities;
}

export interface ProviderSummary {
  id: ProviderId;
  name: string;
  shortName: string;
  protocol: Protocol;
  source: 'shipped' | 'user';
  /** True when the OS profile exists and `detect` resolved. */
  available: boolean;
  executable: string | null;
  models: ModelInfo[];
  capabilities: ProviderCapabilities;
}

/** A descriptor that did not load. Always shown, never silent. */
export interface ProviderRejected {
  file: string;
  field: string;
  expected: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Accounts: a descriptor plus an isolation directory. One account per thread.
// ---------------------------------------------------------------------------

export type AccountStatus = 'unknown' | 'ok' | 'unauthenticated' | 'error';

export interface Account {
  id: AccountId;
  providerId: ProviderId;
  label: string;
  /** Null means the provider's own default location (the user's real login). */
  isolationDir: string | null;
  status: AccountStatus;
  identity: string | null;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Projects and threads.
// ---------------------------------------------------------------------------

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  createdAt: Timestamp;
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

export type ThreadStatus =
  | 'idle'
  /** A turn is waiting for a scheduler slot. */
  | 'queued'
  | 'running'
  /** A permission request is waiting for the user. */
  | 'waiting'
  | 'error';

export interface ThreadLoad {
  processes: number;
  cpuPercent: number;
  memoryBytes: number;
}

export interface ThreadSummary {
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  providerId: ProviderId;
  accountId: AccountId;
  model: string | null;
  /** One of the model's effort level ids. Null means the model's own default. */
  effort: string | null;
  cwd: string;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  unread: boolean;
  archived: boolean;
  /** Provider session id once the first turn has run; used to resume. */
  sessionId: string | null;
  load: ThreadLoad | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** API-equivalent cost. On a subscription this is not money spent; the UI says so. */
  costUsdEquivalent: number | null;
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'stopped' | 'error';

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  status: TurnStatus;
  queuedAt: Timestamp;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  usage: Usage | null;
  error: string | null;
}

export type MessageRole = 'user' | 'assistant' | 'system';

export type ToolStatus = 'running' | 'done' | 'error' | 'denied';

export type MessagePart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      toolId: string;
      name: string;
      input: unknown;
      output: string | null;
      status: ToolStatus;
    }
  | { type: 'permission'; requestId: RequestId; toolName: string; decision: 'allow' | 'deny' | null }
  | { type: 'error'; message: string };

export interface Message {
  id: MessageId;
  threadId: ThreadId;
  turnId: TurnId;
  role: MessageRole;
  parts: MessagePart[];
  state: 'streaming' | 'complete' | 'error';
  createdAt: Timestamp;
}

export interface Thread extends ThreadSummary {
  messages: Message[];
  turns: Turn[];
}

// ---------------------------------------------------------------------------
// Permissions: one gate for every tool call, whatever the driver.
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: RequestId;
  threadId: ThreadId;
  turnId: TurnId;
  toolName: string;
  input: unknown;
  description: string | null;
  createdAt: Timestamp;
}

// ---------------------------------------------------------------------------
// Trace: every process a thread launched, with what it cost.
// ---------------------------------------------------------------------------

export interface ProcessRecord {
  pid: number;
  parentPid: number | null;
  threadId: ThreadId;
  exe: string;
  commandLine: string | null;
  startedAt: Timestamp;
  exitedAt: Timestamp | null;
  exitCode: number | null;
  cpuMs: number | null;
  peakMemoryBytes: number | null;
  ioBytes: number | null;
}

export interface ThreadResources {
  threadId: ThreadId;
  title: string;
  status: ThreadStatus;
  live: ProcessRecord[];
  totals: { processes: number; cpuMs: number; peakMemoryBytes: number };
}

/** What the trace can and cannot promise on this OS. */
export interface TraceCapability {
  os: Os;
  /** 'events' means exact (Windows job completion port); 'poll' may miss sub-second processes. */
  mode: 'events' | 'poll' | 'none';
  note: string;
}

// ---------------------------------------------------------------------------
// Scheduler: a thread is not a process. A process exists only while a turn runs.
// ---------------------------------------------------------------------------

export interface SchedulerState {
  maxConcurrentTurns: number;
  perAccountConcurrency: number;
  running: { turnId: TurnId; threadId: ThreadId; startedAt: Timestamp }[];
  queued: { turnId: TurnId; threadId: ThreadId; position: number; queuedAt: Timestamp }[];
}

export interface Settings {
  maxConcurrentTurns: number;
  perAccountConcurrency: number;
  /** Minutes a Claude process stays warm after a turn. 0 releases it at once. */
  warmProcessMinutes: number;
  /** Bind the RPC to every interface so a phone on the LAN can pair. */
  listenOnLan: boolean;
  /**
   * Hard CPU ceiling for every agent process together, as a percentage of the
   * whole machine. 0 disables the cap. Windows only: it is the global job's
   * CPU rate control, and other systems ignore it.
   */
  agentCpuCapPercent: number;
  /**
   * Memory ceiling for one thread's whole process tree, in megabytes. 0 means
   * no cap. Windows only: it is the thread job's memory limit, and a tree that
   * reaches it fails its next allocation.
   */
  threadMemoryCapMb: number;
}

export interface CoreInfo {
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  os: Os;
  pid: number;
  startedAt: Timestamp;
  endpoint: { host: string; port: number };
  /** URL a phone opens once to pair, token included. */
  pairingUrl: string;
  dataDir: string;
  trace: TraceCapability;
}

// ---------------------------------------------------------------------------
// RPC surface. `hello` must be the first frame on every connection.
// ---------------------------------------------------------------------------

export interface RpcMethods {
  hello: {
    params: { token: string; client: { name: string; version: string } };
    result: { core: CoreInfo };
  };

  'projects.list': { params: Record<string, never>; result: Project[] };
  'projects.add': { params: { path: string; name?: string }; result: Project };
  'projects.remove': { params: { projectId: ProjectId }; result: { ok: true } };

  'providers.list': {
    params: Record<string, never>;
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  'providers.reload': {
    params: Record<string, never>;
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  /** Validate a user descriptor and show what it would do. Writes nothing. */
  'providers.dryRun': {
    params: { file: string };
    result:
      | { ok: true; summary: ProviderSummary; plan: { roots: string[]; env: string[]; closes: string[] } }
      | { ok: false; rejected: ProviderRejected };
  };

  'accounts.list': { params: Record<string, never>; result: Account[] };
  'accounts.add': {
    params: { providerId: ProviderId; label: string; useDefaultLocation?: boolean };
    result: Account;
  };
  'accounts.remove': { params: { accountId: AccountId }; result: { ok: true } };
  'accounts.check': { params: { accountId: AccountId }; result: Account };
  /**
   * Start the provider's login command for this account. Refused when the
   * provider has no `login` block, when the account uses the provider's own
   * location, or when a login is already running for it. Progress arrives as
   * `account.login`.
   */
  'accounts.login': { params: { accountId: AccountId }; result: { ok: true } };
  /** One line into the running login's stdin, for a CLI that asks for a code. */
  'accounts.loginInput': { params: { accountId: AccountId; text: string }; result: { ok: true } };

  'threads.list': { params: { projectId?: ProjectId; includeArchived?: boolean }; result: ThreadSummary[] };
  'threads.create': {
    params: {
      projectId: ProjectId;
      providerId: ProviderId;
      accountId: AccountId;
      title?: string;
      cwd?: string;
      model?: string;
      effort?: string | null;
      permissionMode?: PermissionMode;
    };
    result: ThreadSummary;
  };
  'threads.get': { params: { threadId: ThreadId }; result: Thread };
  'threads.update': {
    params: {
      threadId: ThreadId;
      title?: string;
      model?: string;
      effort?: string | null;
      permissionMode?: PermissionMode;
    };
    result: ThreadSummary;
  };
  'threads.archive': { params: { threadId: ThreadId; archived?: boolean }; result: ThreadSummary };
  'threads.markRead': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Only subscribed threads stream message events to this connection. */
  'threads.subscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  'threads.unsubscribe': { params: { threadId: ThreadId }; result: { ok: true } };

  'turns.start': { params: { threadId: ThreadId; prompt: string }; result: Turn };
  'turns.stop': { params: { threadId: ThreadId }; result: { stopped: boolean } };

  /**
   * The requests still unanswered, in the order they were created; every thread
   * when `threadId` is omitted. A client that connects while a turn waits reads
   * the card here, since `permission.requested` only reached the sockets that
   * were subscribed when it fired.
   */
  'permissions.list': { params: { threadId?: ThreadId }; result: PermissionRequest[] };
  'permissions.answer': {
    params: { requestId: RequestId; decision: 'allow' | 'deny'; updatedInput?: unknown; message?: string };
    result: { ok: true };
  };

  'trace.get': { params: { threadId: ThreadId; limit?: number }; result: ProcessRecord[] };
  'resources.list': { params: Record<string, never>; result: ThreadResources[] };
  'resources.killTree': { params: { threadId: ThreadId }; result: { killed: number } };

  'scheduler.get': { params: Record<string, never>; result: SchedulerState };
  'usage.get': {
    params: { threadId?: ThreadId };
    result: { byThread: Record<ThreadId, Usage>; total: Usage };
  };

  'settings.get': { params: Record<string, never>; result: Settings };
  'settings.set': { params: Partial<Settings>; result: Settings };
}

export type RpcMethodName = keyof RpcMethods;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]['result'];

export interface RpcEvents {
  'thread.created': ThreadSummary;
  'thread.updated': ThreadSummary;
  'thread.removed': { threadId: ThreadId };

  'turn.started': Turn;
  'turn.finished': Turn;

  /** Subscribed threads only, from here to `permission.resolved`. */
  'message.started': Message;
  /** Text appended to the part at `partIndex`. */
  'message.delta': { threadId: ThreadId; messageId: MessageId; partIndex: number; text: string };
  /** A part created or replaced whole (tool call state, permission card). */
  'message.part': { threadId: ThreadId; messageId: MessageId; partIndex: number; part: MessagePart };
  'message.completed': { threadId: ThreadId; messageId: MessageId; state: Message['state'] };

  /** A client that missed this one reads the request from `permissions.list`. */
  'permission.requested': PermissionRequest;
  'permission.resolved': { requestId: RequestId; threadId: ThreadId; decision: 'allow' | 'deny' };

  'process.started': ProcessRecord;
  'process.exited': ProcessRecord;

  'scheduler.updated': SchedulerState;
  'accounts.updated': Account;
  /**
   * The login process starting, one line of its output, or its exit. `url`
   * carries the first `https://` link seen in the output, once there is one.
   * On exit the core rechecks the account and follows with `accounts.updated`.
   */
  'account.login': {
    accountId: AccountId;
    state: 'running' | 'done' | 'failed';
    output: string;
    url: string | null;
    exitCode: number | null;
  };
  'core.log': { level: 'info' | 'warn' | 'error'; message: string; at: Timestamp };
}

export type RpcEventName = keyof RpcEvents;

// ---------------------------------------------------------------------------
// Wire frames: JSON-RPC 2.0 over one WebSocket, one JSON object per frame.
// ---------------------------------------------------------------------------

export interface RpcRequest<M extends RpcMethodName = RpcMethodName> {
  jsonrpc: '2.0';
  id: number | string;
  method: M;
  params: RpcParams<M>;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse<M extends RpcMethodName = RpcMethodName> {
  jsonrpc: '2.0';
  id: number | string;
  result?: RpcResult<M>;
  error?: RpcError;
}

export interface RpcNotification<E extends RpcEventName = RpcEventName> {
  jsonrpc: '2.0';
  method: E;
  params: RpcEvents[E];
}

export type RpcFrame = RpcRequest | RpcResponse | RpcNotification;

export const RpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  /** `hello` missing, late, or with a wrong token. The socket closes after this. */
  Unauthorized: -32001,
  NotFound: -32004,
  /** A refused descriptor, a refused path, a refused origin. Never silent. */
  Refused: -32010,
  /** The provider or account cannot run right now (unauthenticated, missing binary). */
  Unavailable: -32011,
} as const;

/** WebSocket close codes the core uses. */
export const RpcCloseCode = {
  Unauthorized: 4001,
  BadOrigin: 4003,
  ProtocolMismatch: 4010,
} as const;

/** Path of the RPC WebSocket on the core's HTTP server. */
export const RPC_PATH = '/rpc';

/** Query parameter that carries the pairing token when a phone opens the UI. */
export const PAIR_QUERY_PARAM = 'token';

export const CLIENT_NAMES = ['shell', 'pwa', 'test', 'bench'] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];
