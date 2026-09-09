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

/**
 * A release Boite downloads and unpacks itself, for an agent whose binary is
 * not on the machine and has no installer of its own. The files land under
 * `{agentsDir}`, which is what the profile's executable candidate names.
 */
export interface ProviderInstall {
  /** A version string shown to the user and written beside the files. */
  version: string;
  /** A zip archive. */
  url: string;
  sha256: string;
  archiveBytes: number;
  /** Files expected inside the archive, relative paths inside it, with their sizes; the first one is the executable. */
  files: { path: string; bytes: number }[];
}

/**
 * Where a managed install stands. `absent` and `installed` are read from disk
 * at core start; the three middle ones only exist while `providers.install`
 * runs, and `failed` carries its reason until the next attempt.
 *
 * On `installed`, `version` is what sits on disk and `available` is what the
 * descriptor's install block names right now: equal means up to date, different
 * means `providers.install` would fetch that newer release.
 */
export type ProviderInstallState =
  | { state: 'absent'; version: string; archiveBytes: number }
  | { state: 'downloading'; version: string; receivedBytes: number; totalBytes: number; operationId: string }
  | { state: 'verifying' | 'extracting'; version: string; operationId: string }
  | { state: 'installed'; version: string; installedAt: Timestamp; available: string }
  | { state: 'failed'; version: string; message: string };

export interface OsProfile {
  /** The provider is offered only when one of these resolves. */
  detect: { command?: string; file?: string };
  executable: ExecutableCandidate[];
  launch?: { args?: string[] };
  /** A release the core downloads on request. Absent when the agent ships another way. */
  install?: ProviderInstall;
  /**
   * Environment that makes one account blind to the others. Values may use
   * `{isolationDir}`, replaced by the account's own directory.
   */
  isolation: Record<string, string>;
  /**
   * Environment every process of this provider carries, the default account's
   * included, unlike `isolation` which only applies to an isolated one. Values
   * take `{isolationDir}` and the load-time tokens, `{agentsDir}` and
   * `{browserNoop}` among them. Antigravity is what needs it: its harness path
   * and its browser suppression are not about isolation.
   */
  env?: Record<string, string>;
  /**
   * Names removed from the inherited environment before a process of this
   * provider starts, so a variable the user set for their own CLI cannot
   * redirect the agent Boite runs.
   */
  unsetEnv?: string[];
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
 * How the provider logs one account in, in one of two shapes and never both.
 *
 * `command` is a CLI Boite runs under the account's isolation directory,
 * streaming its output back as `account.login`; the user answers a prompt with
 * `accounts.loginInput`.
 *
 * `acp` is the protocol's own `authenticate` call: the core starts the agent
 * like a turn would, sends `initialize` then `authenticate` with that method
 * id, and streams what the agent prints outside the ndjson stream, the sign-in
 * link included. A redirect URL pasted with `accounts.loginInput` is fetched
 * once, which is how a phone finishes a sign-in the desktop browser started.
 */
export interface ProviderLogin {
  /** The executable and its arguments. Never empty. */
  command?: string[];
  /** Extra environment for the login process. Values may use `{isolationDir}`. */
  env?: Record<string, string>;
  /** The ACP `authenticate` method id, for an agent that logs in over the protocol. */
  acp?: { methodId: string };
}

/** How this provider's accounts are kept apart, whatever the OS profile does. */
export interface ProviderIsolation {
  /**
   * Every account of this provider gets a directory of its own, the default one
   * included, so nothing ever reaches the user's own login. Antigravity is the
   * case: its IDE credentials are never Boite's to use.
   */
  alwaysIsolated: boolean;
}

/**
 * Quirks a driver applies to one agent's dialect of a protocol. A value the
 * core does not know is refused at load time rather than ignored.
 */
export type ProviderQuirk = 'antigravity' | 'grok';

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
  /** Absent means the default account uses the provider's own location. */
  isolation?: ProviderIsolation;
  /**
   * Files the core writes under an account's isolation directory before the
   * agent ever runs: a relative path to the exact content it must hold. Written
   * when the account is created and checked again before every spawn; a file
   * already there is left alone, because the agent owns it afterwards.
   */
  seedFiles?: Record<string, string>;
  /** Dialect fixes the driver of this protocol applies for this agent only. */
  quirks?: ProviderQuirk[];
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
  /** Where the managed install stands, null when this profile has no `install` block. */
  install: ProviderInstallState | null;
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

/** What a tool call produced or changed, shown under the card's input and output. */
export type ToolDocument =
  /** A file the tool wrote: the two texts, the UI computes the line diff. */
  | { kind: 'diff'; path: string; oldText: string; newText: string }
  | { kind: 'markdown'; title: string | null; text: string }
  /** `data` is base64 with no `data:` prefix. The core caps it before it is journalled. */
  | { kind: 'image'; mimeType: string; data: string; alt: string | null };

export type MessagePart =
  | { type: 'text'; text: string }
  /** The model's reasoning as the provider streams it, folded in the UI. */
  | { type: 'thinking'; text: string }
  | {
      type: 'tool';
      toolId: string;
      name: string;
      input: unknown;
      /** The input's JSON as the model streams it, before `input` is complete. Absent or null once `input` is final. */
      inputText?: string | null;
      output: string | null;
      status: ToolStatus;
      /** What the call produced or changed, under the input and the output. Absent on a journal row written before documents existed. */
      documents?: ToolDocument[];
    }
  | { type: 'permission'; requestId: RequestId; toolName: string; decision: 'allow' | 'deny' | null }
  /**
   * A free-form question the agent asked. The card is answered from the
   * timeline, and `answer` is written back into the part once it is. Null or
   * absent means it is still waiting.
   */
  | {
      type: 'question';
      questionId: RequestId;
      text: string;
      options: QuestionOption[];
      /** A question with no options and this true is a plain free-text prompt. */
      allowText: boolean;
      multiple: boolean;
      answer?: QuestionAnswer | null;
    }
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

/** How many messages `threads.get` returns, and what `messages.list` gives when it is asked for no limit. */
export const MESSAGE_PAGE = 120;
/** The most `messages.list` will ever hand back in one call, whatever `limit` says. */
export const MESSAGE_PAGE_MAX = 200;

export interface Thread extends ThreadSummary {
  /** The last `MESSAGE_PAGE` messages of the thread, oldest first. Older ones come from `messages.list`. */
  messages: Message[];
  /**
   * The oldest message `messages` carries, when the thread has older ones behind
   * it; null when this page is the whole thread. It is the cursor `messages.list`
   * takes as `before`.
   */
  messagesBefore: MessageId | null;
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
// Questions: what an agent asks the user that is not a tool call.
// ---------------------------------------------------------------------------

/** One choice on a question card. */
export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

/** What the user picked. `text` is the free field, when the question has one. */
export interface QuestionAnswer {
  optionIds: string[];
  text?: string;
}

/**
 * A question waiting for the user. A driver whose protocol asks something that
 * is not a permission maps it here, one request per question, in order.
 */
export interface QuestionRequest {
  id: RequestId;
  threadId: ThreadId;
  turnId: TurnId;
  text: string;
  options: QuestionOption[];
  /** No options plus this true is a plain free-text prompt. */
  allowText: boolean;
  multiple: boolean;
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
  /**
   * Windows of agent processes never keep the foreground: one that takes it is
   * sent to the bottom without activation and the window the user was on gets
   * the focus back. Windows only, ignored elsewhere.
   */
  focusGuard: boolean;
  /**
   * Audio sessions of agent processes are muted while they run, so a sound an
   * agent plays never reaches the user's speakers. The mute is undone when the
   * process exits. Windows only, ignored elsewhere.
   */
  muteAgents: boolean;
}

/**
 * Which install of Boite this is. `stable` is the app the user works in every
 * day; `dev` is a second install beside it, with its own identifier, its own
 * product name and its own data directory, so a beta build never overwrites
 * the stable one nor reads its journal.
 */
export type Channel = 'stable' | 'dev';

export interface CoreInfo {
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  os: Os;
  /** The install this core belongs to. `--channel` on its command line decides. */
  channel: Channel;
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
  /**
   * The models this provider can actually run on this account. For an ACP
   * provider they are the ones the agent lists in the `configOptions` of a
   * `session/new`, read from one short-lived agent process under the account's
   * environment, and kept until `providers.reload` or a change to that account.
   * For any other protocol they are the descriptor's models, with `probedAt`
   * the moment of the call.
   */
  'providers.probe': {
    params: { providerId: ProviderId; accountId: AccountId };
    result: { models: ModelInfo[]; probedAt: Timestamp };
  };
  /**
   * Download and unpack the release this profile's `install` block names. On a
   * provider already installed at an older version this is the update: the new
   * release lands beside the old one and `current` is repointed, the old
   * directory staying until `providers.uninstall` because a process may still
   * be running out of it. Refused when the profile carries no such block, when
   * the installed version is already the one the descriptor names, when an
   * install is already running for that provider, or when the free space under
   * the data directory is under the archive plus the unpacked files plus a
   * 256 MB margin. Progress arrives as `providers.installProgress`.
   */
  'providers.install': { params: { providerId: ProviderId }; result: ProviderInstallState };
  /** Abort the running install. The operation id is the one its state carries. */
  'providers.installCancel': {
    params: { providerId: ProviderId; operationId: string };
    result: ProviderInstallState;
  };
  /** Delete what a managed install put on disk. Refused while a process of that provider is alive. */
  'providers.uninstall': { params: { providerId: ProviderId }; result: ProviderInstallState };
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
  /**
   * The thread with its last `MESSAGE_PAGE` messages and the cursor for what is
   * behind them. Opening a thousand-message thread costs one page, not the lot.
   */
  'threads.get': { params: { threadId: ThreadId }; result: Thread };
  /**
   * One page of older messages, oldest first inside the page: what was written
   * before `before`, at most `limit` (`MESSAGE_PAGE` by default, `MESSAGE_PAGE_MAX`
   * whatever is asked). The result's own `before` is the next cursor, null once
   * the first message of the thread is in hand. An unknown thread is a not-found;
   * a `before` that is not a message of that thread is refused by name.
   */
  'messages.list': {
    params: { threadId: ThreadId; before: MessageId; limit?: number };
    result: { messages: Message[]; before: MessageId | null };
  };
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

  /**
   * The questions still unanswered, oldest first; every thread when `threadId`
   * is omitted. Same reason as `permissions.list`: a client that connects while
   * a turn waits rebuilds the card from here.
   */
  'questions.list': { params: { threadId?: ThreadId }; result: QuestionRequest[] };
  /**
   * One answer. `optionIds` are ids the question listed and `text` the free
   * field it allowed. A question that is not pending is refused, naming the id.
   */
  'questions.answer': {
    params: { threadId: ThreadId; questionId: RequestId; optionIds: string[]; text?: string };
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
  /** A project `projects.add` created. A known path returns its project without one. */
  'project.added': Project;
  /** A project `projects.remove` deleted, after the `thread.removed` of each of its threads. */
  'project.removed': { projectId: ProjectId };

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

  /** A client that missed this one reads the question from `questions.list`. */
  'question.asked': QuestionRequest;
  /** The answer, or null when the turn ended before one came. */
  'question.answered': { questionId: RequestId; threadId: ThreadId; answer: QuestionAnswer | null };

  'process.started': ProcessRecord;
  'process.exited': ProcessRecord;
  /**
   * A window of a process this thread launched took the foreground and was sent
   * back behind everything without activation. `restored` says whether the
   * window the user was on got the focus back. Windows only.
   */
  'process.focusPushed': {
    threadId: ThreadId;
    pid: number;
    title: string;
    restored: boolean;
    at: Timestamp;
  };
  /**
   * An audio session of a process this thread launched was muted, and stays
   * muted until that process exits. Windows only.
   */
  'process.muted': { threadId: ThreadId; pid: number; at: Timestamp };

  'scheduler.updated': SchedulerState;
  'accounts.updated': Account;
  /** An account `accounts.remove` deleted. */
  'accounts.removed': { accountId: AccountId };
  /** The whole settings object, as `settings.set` wrote it. */
  'settings.updated': Settings;
  /** What `providers.reload` found: the descriptors that loaded and the ones refused. */
  'providers.updated': { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  /**
   * A managed install moved. Emitted on every state change, and while the
   * archive downloads at most four times a second. `providers.updated` follows
   * once the files land or are removed, so every client re-lists.
   */
  'providers.installProgress': ProviderInstallState & { providerId: ProviderId };
  /** Every `providers.probe` that completed, so a second client sees the same models. */
  'providers.probed': {
    providerId: ProviderId;
    accountId: AccountId;
    models: ModelInfo[];
    probedAt: Timestamp;
  };
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
