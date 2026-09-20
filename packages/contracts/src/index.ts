/**
 * Boite 2 wire contract: the JSON-RPC methods and events between the core
 * (the host process that runs the agents) and its clients (the desktop shell,
 * the phone PWA, tests, benches).
 *
 * The core is the only side that executes anything. Clients drive it over an
 * authenticated WebSocket. This file is the whole vocabulary; a method or an
 * event that is not here does not exist.
 */

export const PROTOCOL_VERSION = 2 as const;

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

/**
 * How the core talks to an agent. `agy` is the Antigravity CLI's own print
 * mode, `agy -p= --input-format stream-json --output-format stream-json`: one
 * JSON prompt per line on stdin, one JSON event per line on stdout.
 */
export type Protocol = 'claude-sdk' | 'codex-appserver' | 'muse' | 'pi' | 'acp' | 'agy' | 'echo';

export type Os = 'windows' | 'linux' | 'macos';

export interface ExecutableCandidate {
  /**
   * Where to look, in order. The user override always wins over all of these.
   * `npm` names a package (`@scope/name`, `#bin` to pick one of several) that
   * Boite finds in the global npm, pnpm or Bun install directories and runs as
   * `node <its bin script>`; only the `pi` and `acp` protocols take one.
   */
  kind: 'path' | 'file' | 'npm';
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
  /** Omitted for zip archives; binary downloads contain exactly one file. */
  format?: 'zip' | 'binary';
  /** The archive or executable download. */
  url: string;
  sha256: string;
  archiveBytes: number;
  /** Omit for architecture-independent archives. */
  arch?: 'x64' | 'arm64';
  /** Files expected inside the archive, relative paths inside it, with their sizes; the first one is the executable. */
  files: { path: string; bytes: number; executable?: boolean }[];
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
  /** Native service tiers advertised for this model; absent means no speed control. */
  speeds?: { id: string; label: string; description?: string }[];
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
  /** Whether Boite can start login, and which protocol owns it. */
  login: false | { kind: 'command' | 'acp' };
  /** True when the provider cannot use its default login location. */
  alwaysIsolated: boolean;
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

export interface QuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt: Timestamp | null;
}

/** Provider-reported limits, never inferred from Boite's token ledger. */
export interface AccountQuota {
  /** Account id, or `quota:antigravity-cli` for the opt-in local CLI quota source. */
  accountId: AccountId;
  providerId: ProviderId;
  providerName: string;
  label: string;
  enabled: boolean;
  status: 'ready' | 'unavailable' | 'unsupported' | 'disabled';
  windows: QuotaWindow[];
  checkedAt: Timestamp | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Plugins: one manifest format, `boite-plugin.json`. The recommended ones ship
// inside the core; the owner adds others from a git URL. docs/plugins.md.
// ---------------------------------------------------------------------------

/** The file a plugin repository carries at its root. */
export const PLUGIN_MANIFEST_FILE = 'boite-plugin.json';
/** The one manifest schema this core reads. */
export const PLUGIN_MANIFEST_SCHEMA = 1;
/** `${process.platform}-${process.arch}` keys an artifact may be published for. */
export const PLUGIN_PLATFORMS = ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64', 'linux-x64', 'linux-arm64'] as const;
export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/** One native executable, downloaded over https and checked against its digest. */
export interface PluginArtifact {
  url: string;
  /** Lowercase hex SHA-256 of the file at `url`. */
  sha256: string;
}

/** What Boite does with the executable. Account pools are the one feature today. */
export interface PluginProvides {
  /** The executable answers the account pool commands for these providers. */
  accountPools?: { providers: ProviderId[] };
}

export interface PluginManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  /** https page of the project, shown as its source link. */
  homepage: string;
  /** The file name Boite writes, `.exe` appended on Windows. */
  executable: string;
  artifacts: Partial<Record<PluginPlatform, PluginArtifact>>;
  provides: PluginProvides;
}

/** Where a plugin added from a URL came from. */
export interface PluginSource {
  /** The repository URL, as the core normalized it. */
  url: string;
  /** The branch, tag or commit asked for, `HEAD` when none was. */
  ref: string;
  /** The commit the manifest was read at. */
  commit: string;
}

/** A manifest the core refused, with the file, the field and what it expected. */
export interface PluginRejected {
  file: string;
  field: string;
  expected: string;
  message: string;
}

export interface PluginState {
  id: string;
  name: string;
  /** Shipped in the core's recommended list, or added by the owner from a git URL. */
  origin: 'recommended' | 'url';
  description: string;
  homepage: string | null;
  /** The version on disk, null while nothing is installed. */
  version: string | null;
  /** The version an install or an update brings. */
  availableVersion: string | null;
  status: 'not-installed' | 'installed' | 'installing' | 'error' | 'rejected';
  progress: number;
  error: string | null;
  /** Null for a recommended plugin. */
  source: PluginSource | null;
  /** What an install downloads on this machine, null when the manifest publishes nothing for it. */
  artifact: PluginArtifact | null;
  /** This machine's key, `win32-x64` and so on. */
  platform: string;
  /** The command lines Boite runs, `<pool>` and `<email>` standing for the values. */
  commands: string[];
  /** The providers whose account pools the plugin serves. */
  pools: ProviderId[];
  /** Set exactly when `status` is `rejected`. */
  rejected: PluginRejected | null;
}

/** What `plugins.inspect` read, shown to the owner before anything is downloaded. */
export interface PluginPreview {
  /** What `plugins.add` takes. Null when the manifest was refused. */
  previewId: string | null;
  source: PluginSource;
  manifest: PluginManifest | null;
  rejected: PluginRejected | null;
  artifact: PluginArtifact | null;
  platform: string;
  commands: string[];
  /** The version installed under the same id, which this install replaces. */
  replaces: string | null;
  expiresAt: Timestamp;
}

export interface PluginPool {
  provider: string;
  accounts: { email: string; active: boolean; windows: QuotaWindow[]; checkedSecondsAgo: number | null }[];
}

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

/**
 * Who wrote the thread's title. `prompt` is the first line of the first
 * prompt, what a client sends on `threads.create`; `agent` is what the agent
 * itself answered after the first turn or on `threads.retitle`; `user` is a
 * `threads.update` with a title, after which nothing rewrites it unasked.
 */
export type TitleSource = 'prompt' | 'agent' | 'user';

/**
 * How full the agent's context is, as of the last request it made: `tokens`
 * is what that request carried (input plus cache reads and writes), `window`
 * the model's context window when the agent says it, null when it does not.
 * Null on a thread whose agent never reported it.
 */
export interface ContextUse {
  /** Disjoint counts from the last request, when the provider reports them. */
  breakdown?: { input: number; cache: number; output: number };
  tokens: number;
  window: number | null;
  at: Timestamp;
}

export interface ThreadSummary {
  /** Last accepted user message, independent of assistant activity and renames. */
  lastUserMessageAt?: Timestamp | null;
  pullRequest?: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null;
  id: ThreadId;
  projectId: ProjectId;
  title: string;
  titleSource: TitleSource;
  providerId: ProviderId;
  accountId: AccountId;
  model: string | null;
  /** One of the model's effort level ids. Null means the model's own default. */
  effort: string | null;
  speed?: string | null;
  cwd: string;
  /**
   * The git branch the thread works on when it started in its own worktree;
   * `cwd` is then that worktree, not the project. Null for a thread that works
   * in the project directory itself.
   */
  branch: string | null;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  unread: boolean;
  archived: boolean;
  /** Kept above the other threads of its project in the sidebar, whatever runs. */
  pinned: boolean;
  /** Provider session id once the first turn has run; used to resume. */
  sessionId: string | null;
  /** Changes when the account changes; native sessions never cross this boundary. */
  sessionGeneration?: number;
  /** Optimistic revision of the selection for future turns. Missing on older clients means zero. */
  selectionVersion?: number;
  load: ThreadLoad | null;
  /** The context meter, written at the end of every turn whose agent reports its usage. */
  context: ContextUse | null;
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

/**
 * The finished turns of one provider and model whose `finishedAt` falls in
 * `[edges[bucket], edges[bucket + 1])` of a `usage.history` call.
 */
export interface UsageHistoryRow {
  bucket: number;
  providerId: ProviderId;
  /** Null when the turn ran on the provider's default model. */
  model: string | null;
  /** Finished turns, whether or not the agent reported its usage. */
  turns: number;
  /** Turns among them that carried a usage report. */
  reported: number;
  /** Turns among them that carried an API-equivalent price. */
  priced: number;
  /**
   * Sums over the reported turns. `inputTokens` never includes the cache reads,
   * whatever the provider counts, so the four token fields add up to the tokens
   * processed. `costUsdEquivalent` is null when no turn of the row was priced.
   */
  usage: Usage;
}

export interface UsageHistoryThread {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId;
  providerId: ProviderId;
  archived: boolean;
  turns: number;
  usage: Usage;
}

export interface UsageHistory {
  edges: Timestamp[];
  rows: UsageHistoryRow[];
  /**
   * The threads that spent the most over the whole range, by tokens, by cost
   * and by turns, so a client can rank by any of the three. Unordered.
   */
  threads: UsageHistoryThread[];
}

export type TurnStatus = 'queued' | 'running' | 'done' | 'stopped' | 'error';

/** Frozen when a prompt is accepted, including while it waits in the scheduler. */
export type TurnExecution = Pick<ThreadSummary,
  'providerId' | 'accountId' | 'model' | 'effort' | 'speed' | 'permissionMode' | 'sessionId'
> & { sessionGeneration: number; selectionVersion: number; operation?: 'compact' };

export interface Turn {
  id: TurnId;
  threadId: ThreadId;
  status: TurnStatus;
  queuedAt: Timestamp;
  startedAt: Timestamp | null;
  finishedAt: Timestamp | null;
  usage: Usage | null;
  error: string | null;
  /** Absent only for turns saved before execution snapshots were introduced. */
  execution?: TurnExecution;
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

/** The image formats every agent that takes images accepts. */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];
/** The maximum decoded bytes per attachment, including non-image files. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
/** The maximum total number of attachments per turn. */
export const ATTACHMENTS_PER_TURN = 8;

/**
 * An image sent with a prompt. `data` is base64 with no `data:` prefix. The
 * core refuses one over `ATTACHMENT_MAX_BYTES`, more than `ATTACHMENTS_PER_TURN`
 * of them, a format outside `IMAGE_MIME_TYPES`, and any of them on a provider
 * whose `capabilities.images` is false, each by name.
 */
export interface ImageAttachment {
  kind: 'image';
  mimeType: ImageMimeType;
  data: string;
  /** The file name when it came from one, for the timeline's tooltip. */
  name: string | null;
}

/** A file uploaded to the core and made available to the agent as a local path. */
export interface FileAttachment {
  kind: 'file';
  mimeType: string;
  data: string;
  name: string | null;
}

export type Attachment = ImageAttachment | FileAttachment;

export type MessagePart =
  | { type: 'text'; text: string; displayText?: string; activity?: { kind: 'goal' | 'loop'; iteration: number } }
  /** An image the user sent with the prompt, journalled with the message. */
  | { type: 'image'; mimeType: ImageMimeType; data: string; alt: string | null }
  | { type: 'file'; mimeType: string; data: string; name: string | null }
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
  /**
   * The agent compacted its context mid-turn: what it held before, what is
   * left after when it says so. Drawn as a divider in the timeline.
   */
  | { type: 'compaction'; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null }
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

/**
 * A command the agent of a thread takes at the start of a prompt, sent as the
 * text `/name` followed by its input. Claude lists its skills here, an ACP agent
 * its `available_commands_update`, pi its `get_commands`. Boite's own commands
 * are the client's and never in this list.
 */
export interface AgentCommand {
  /** Without the leading slash. */
  name: string;
  description: string | null;
  /** What goes after the name, as the agent words it (`<file>`), or null. */
  hint: string | null;
}

export interface AgentTask {
  id: string;
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ThreadActivity {
  goal: { objective: string; status: 'active' | 'paused' | 'complete'; iterations: number; error: string | null; dismissed?: boolean } | null;
  loop: { prompt: string; intervalMs: number; maxIterations?: number | null; status: 'active' | 'paused' | 'complete'; iterations: number; nextRunAt: number | null; error: string | null; history?: ActivityIteration[] } | null;
  tasks: AgentTask[];
  tasksDismissed?: boolean;
}

export interface ActivityIteration {
  iteration: number;
  turnId: TurnId;
  status: 'running' | 'done' | 'error' | 'stopped';
  summary: string;
  startedAt: Timestamp;
  finishedAt: Timestamp | null;
}

export interface Thread extends ThreadSummary {
  activity?: ThreadActivity;
  /** The last `MESSAGE_PAGE` messages of the thread, oldest first. Older ones come from `messages.list`. */
  messages: Message[];
  /**
   * What the agent of this thread last said it takes as `/name`. Empty until a
   * session of this core reported them: the list is the agent's, kept in
   * memory, and `thread.commands` follows every change.
   */
  commands: AgentCommand[];
  /**
   * The oldest message `messages` carries, when the thread has older ones behind
   * it; null when this page is the whole thread. It is the cursor `messages.list`
   * takes as `before`.
   */
  messagesBefore: MessageId | null;
  /** The turns `messages` refers to, plus any still queued or running; never the whole history. */
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
  /** Exact browser origins allowed to connect alongside the shell and this core's own origin. */
  browserOrigins?: string[];
  /** HTTPS origin served by the reverse proxy, used in phone pairing links. */
  publicUrl?: string | null;
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

// ---------------------------------------------------------------------------
// Keybindings: one file in the data directory, read by the core, applied by
// every client. The defaults are the UI's; the file only says what differs.
// ---------------------------------------------------------------------------

/** Every command a chord can be bound to. The UI owns the default chord of each. */
export const KEYBINDING_COMMANDS = [
  'new-thread',
  'palette',
  'sidebar',
  'panel',
  'browser',
  'changes',
  'files',
  'tasks',
  'close-surface',
  'settings',
  'stash',
  'send-and-draft',
  'add-project',
  'pin',
  'rename',
  'retitle',
  'trace',
  'appearance',
  'providers',
  'pair',
  'theme-dark',
  'theme-light',
  'theme-system',
  'archive',
  'import-session',
] as const;
export type KeybindingCommand = (typeof KEYBINDING_COMMANDS)[number];

// ---------------------------------------------------------------------------
// Imports: a session an agent ran outside Boite, read from its own transcript
// files and turned into a thread the agent can resume.
// ---------------------------------------------------------------------------

/** One session an account's agent kept on disk for a project's folder. Claude Code today. */
export interface ImportableSession {
  providerId: ProviderId;
  accountId: AccountId;
  /** The agent's own id for the session, what a resumed turn hands back to it. */
  sessionId: string;
  /** The transcript file, absolute. */
  file: string;
  /** The title: the agent's own when the transcript carries one, else the first prompt's first line. */
  title: string;
  /** The first prompt's time. */
  startedAt: Timestamp;
  /** The file's last write. */
  updatedAt: Timestamp;
  bytes: number;
  /** The thread that already carries this session, so it is not imported twice. */
  threadId: ThreadId | null;
}

/** What `<dataDir>/keybindings.json` says, as the core last read it. */
export interface Keybindings {
  /** The file itself, which may not exist yet. */
  path: string;
  /**
   * Command id to chord, `mod+shift+k` style, or null to leave the command
   * with no key. Only the entries the file names; the rest keep their default.
   */
  bindings: Partial<Record<KeybindingCommand, string | null>>;
  /**
   * Every line of the file the core could not take, each naming the file, the
   * entry and what was expected. A file that is not JSON is one error and no
   * binding at all.
   */
  errors: string[];
}

/** A chord parsed: which modifiers it holds and the key that ends it. */
export interface Chord {
  /** The platform's primary modifier: Ctrl on Windows and Linux, Cmd on macOS. */
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** The key as `KeyboardEvent.key` reports it, lowercased: `k`, `,`, `enter`, `arrowup`, `f5`. */
  key: string;
}

const CHORD_MODIFIERS: Record<string, keyof Omit<Chord, 'key'>> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  meta: 'meta',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
};

/** The named keys a chord may end with, and what `KeyboardEvent.key` says for each. */
const CHORD_KEYS: Record<string, string> = {
  enter: 'enter',
  return: 'enter',
  escape: 'escape',
  esc: 'escape',
  tab: 'tab',
  space: ' ',
  backspace: 'backspace',
  delete: 'delete',
  del: 'delete',
  insert: 'insert',
  home: 'home',
  end: 'end',
  pageup: 'pageup',
  pagedown: 'pagedown',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  comma: ',',
  period: '.',
  slash: '/',
  backslash: '\\',
  minus: '-',
  equal: '=',
  plus: '+',
  backquote: '`',
  bracketleft: '[',
  bracketright: ']',
  semicolon: ';',
  quote: "'",
};

/**
 * Reads a chord such as `mod+shift+k`, `ctrl+alt+b`, `mod+,` or `f5`. A chord
 * needs `mod`, `ctrl`, `alt` or `meta` unless its key is a function key: a
 * bare letter, or Shift alone, is typing. The refusal names what was wrong.
 */
export function parseChord(text: string): { ok: true; chord: Chord } | { ok: false; reason: string } {
  const parts = text.split('+').map((part) => part.trim().toLowerCase());
  // `mod++` is Mod and the plus key: the empty part between the two signs marks it.
  const plusAt = parts.indexOf('', 1);
  if (plusAt !== -1 && plusAt === parts.length - 2 && parts[parts.length - 1] === '') parts.splice(plusAt, 2, 'plus');
  const chord: Chord = { mod: false, ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const modifier = CHORD_MODIFIERS[part];
    if (modifier !== undefined && !last) {
      if (chord[modifier]) return { ok: false, reason: `"${text}" names ${part} twice` };
      chord[modifier] = true;
      continue;
    }
    if (!last) return { ok: false, reason: `"${text}" has "${part}" where a modifier was expected (mod, ctrl, alt, shift, meta)` };
    if (part === '') return { ok: false, reason: `"${text}" names no key` };
    if (modifier !== undefined) return { ok: false, reason: `"${text}" ends on a modifier and names no key` };
    const named = CHORD_KEYS[part];
    if (named !== undefined) chord.key = named;
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(part)) chord.key = part;
    else if ([...part].length === 1) chord.key = part;
    else return { ok: false, reason: `"${text}" has an unknown key "${part}" (a character, enter, escape, tab, space, up, down, left, right, home, end, pageup, pagedown, backspace, delete or f1 to f24)` };
  }
  const isFunctionKey = /^f\d+$/.test(chord.key);
  if (!chord.mod && !chord.ctrl && !chord.alt && !chord.meta && !isFunctionKey) {
    return { ok: false, reason: `"${text}" has no modifier: a chord needs mod, ctrl, alt or meta before its key` };
  }
  return { ok: true, chord };
}

/**
 * Which install of Boite this is. `stable` is the app the user works in every
 * day; `dev` is a second install beside it, with its own identifier, its own
 * product name and its own data directory, so a beta build never overwrites
 * the stable one nor reads its journal.
 */
export type Channel = 'stable' | 'dev';

export interface CoreInfo {
  /** Display name reported by the execution host. */
  hostname?: string;
  version: string;
  protocolVersion: typeof PROTOCOL_VERSION;
  os: Os;
  /** The install this core belongs to. `--channel` on its command line decides. */
  channel: Channel;
  pid: number;
  startedAt: Timestamp;
  /** Bind address, possibly a wildcard. `pairing.grant` gives the link a phone opens. */
  endpoint: { host: string; port: number };
  dataDir: string;
  trace: TraceCapability;
}

/**
 * Who a connection is. The owner said hello with the core token itself, which
 * only the shell, the tests and `boite-core pair` hold, or with the key of a
 * pairing whose role was `owner`; a session said hello with a token the core
 * minted for a `device` pairing; an agent said hello with the per-thread token
 * the core put in the environment of a process that thread launched, and is
 * held to `AGENT_METHODS` on that one thread. Minting grants and revoking
 * sessions are the owner's alone.
 */
export type Principal = 'owner' | 'session' | 'agent';

// ---------------------------------------------------------------------------
// The agent's door. Every process a thread launches carries these variables
// and the `boite` CLI on its PATH. The CLI says hello with the token, becomes
// the `agent` principal of that thread, and every call it makes names that
// thread: a call that names another one is refused.
// ---------------------------------------------------------------------------

export const AGENT_ENV = {
  threadId: 'BOITE_THREAD_ID',
  coreUrl: 'BOITE_CORE_URL',
  token: 'BOITE_AGENT_TOKEN',
} as const;

/** Where the agent is, as `agent.where` answers and the CLI prints it. */
export interface AgentWhere {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId;
  projectPath: string;
  /** The thread's working directory: the project, or its worktree. */
  cwd: string;
  branch: string | null;
  worktree: boolean;
  providerId: ProviderId;
  model: string;
}

/**
 * What the right panel shows on request. `file` opens the file at the line;
 * `diff` opens the changes, on one file when a path is given; `browser` opens
 * the url in the panel's browser; `trace` and `tasks` open those surfaces.
 * Paths are relative to the thread's working directory or absolute inside it.
 */
export type PanelSurface =
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'files'; path?: string }
  | { kind: 'diff'; path?: string }
  | { kind: 'browser'; url: string }
  | { kind: 'trace' }
  | { kind: 'tasks' };

export const PANEL_SURFACE_KINDS = ['file', 'files', 'diff', 'browser', 'trace', 'tasks'] as const;
export type PanelSurfaceKind = (typeof PANEL_SURFACE_KINDS)[number];

/**
 * One card of a project's todo list, shared by every thread of the project.
 * `claimed` is a card a thread finished and the user has not confirmed yet.
 */
export interface Todo {
  id: string;
  projectId: ProjectId;
  text: string;
  status: 'open' | 'claimed' | 'done';
  /** The thread that added or last moved it, null when the user did. */
  threadId: ThreadId | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export const TODO_STATUSES: readonly Todo['status'][] = ['open', 'claimed', 'done'];

export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflict';

/** One path `git status` reports, staged or not, with the numbers `git diff --numstat` gives it. */
export interface GitChange {
  path: string;
  status: GitChangeStatus;
  /** The previous path of a rename or copy. */
  oldPath: string | null;
  staged: boolean;
  /** Null on a binary or untracked file. */
  additions: number | null;
  deletions: number | null;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

/** Both sides of one file, the working tree against `ref` (HEAD by default). */
export interface GitDiff {
  path: string;
  oldPath: string | null;
  status: GitChangeStatus;
  /** Null when the side does not exist: an added or a deleted file. */
  oldText: string | null;
  newText: string | null;
  binary: boolean;
  /** Either side was cut at `DIFF_MAX_BYTES`. */
  truncated: boolean;
}

export interface FileEntry {
  name: string;
  /** Relative to the thread's working directory, forward slashes. */
  path: string;
  kind: 'file' | 'dir';
  bytes: number | null;
  modifiedAt: Timestamp;
}

/**
 * What `files.read` answers. Text comes inline; a picture, a video, a sound or
 * anything else binary comes as a `url` that is a path on the core's HTTP
 * server (`/file/<ticket>`), for the client to resolve against the origin it
 * reached the core by. It is valid for `FILE_TICKET_TTL_MS` and answers range
 * requests so a video seeks.
 */
export type FileContent =
  | { kind: 'text'; path: string; bytes: number; modifiedAt: Timestamp; text: string; truncated: boolean; language: string | null }
  | { kind: 'image' | 'video' | 'audio' | 'binary'; path: string; bytes: number; modifiedAt: Timestamp; mime: string; url: string };

/** Path prefix of the ticketed file route: `GET <core>/file/<ticket>`. */
export const FILE_ROUTE = '/file';
export const FILE_TICKET_TTL_MS = 10 * 60 * 1000;
/** A text file is read whole up to this size, then cut and marked truncated. */
export const FILE_MAX_BYTES = 2 * 1024 * 1024;
export const DIFF_MAX_BYTES = 1024 * 1024;
export const FILES_LIST_MAX = 2000;

/**
 * What a pairing link hands over. `device` is the guest a phone is, held to
 * `DEVICE_METHODS`. `owner` is another computer of the owner's driving a core
 * that runs elsewhere, a server say: its session key says hello as `owner` and
 * reaches every method, and it is still a row `sessions.revoke` can take away.
 */
export type PairingRole = 'device' | 'owner';

/** One paired client, as `sessions.list` shows it. The token itself is never listed. */
export interface PairedSession {
  id: string;
  client: { name: string; version: string };
  role: PairingRole;
  createdAt: Timestamp;
  lastSeenAt: Timestamp;
  /** True on the connection that asked. */
  current: boolean;
}

/**
 * A one-time pairing link. The grant inside it is exchanged once, within
 * `expiresAt`, for a session token of the client's own; the core token never
 * leaves the machine. A grant that was used or that expired is refused by name.
 */
export interface PairingGrant {
  url: string;
  grant: string;
  role: PairingRole;
  expiresAt: Timestamp;
}

// ---------------------------------------------------------------------------
// RPC surface. `hello` must be the first frame on every connection.
// ---------------------------------------------------------------------------

export type SpeechEngine = 'local' | 'api';
export interface SpeechConfig {
  engine: SpeechEngine;
  language: string;
  apiProvider: 'groq' | 'openrouter';
  fallback: boolean;
  executable: string;
  modelPath: string;
}
export interface SpeechStatus {
  revision: string;
  engine: SpeechEngine;
  ready: boolean;
  localReady: boolean;
  groqKeySet: boolean;
  openrouterKeySet: boolean;
  installing: boolean;
  downloadedBytes: number;
  totalBytes: number;
  error: string | null;
  canInstallRuntime: boolean;
}
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_BYTES = 44 + 16000 * 2 * SPEECH_MAX_SECONDS;

export interface RpcMethods {
  'speech.status': { params: Record<string, never>; result: SpeechStatus };
  'speech.configure': { params: SpeechConfig & { groqKey?: string; openrouterKey?: string }; result: SpeechStatus };
  'speech.config': { params: Record<string, never>; result: SpeechConfig };
  'speech.install': { params: Record<string, never>; result: SpeechStatus };
  'speech.installCancel': { params: Record<string, never>; result: SpeechStatus };
  'speech.uninstall': { params: Record<string, never>; result: SpeechStatus };
  /** PCM WAV, mono 16 kHz. Each connection may have one request in flight. Audio is never journalled. */
  'speech.transcribe': { params: { requestId: string; revision: string; audio: string }; result: { text: string } };
  'speech.cancel': { params: { requestId: string }; result: { ok: true } };
  'threads.activity.set': { params: { threadId: ThreadId; goal?: { objective: string } | null; loop?: { prompt: string; intervalMs: number; maxIterations?: number | null } | null }; result: ThreadActivity };
  'threads.activity.control': { params: { threadId: ThreadId; kind: 'goal' | 'loop'; action: 'pause' | 'resume' | 'remove' | 'complete' }; result: ThreadActivity };
  'quotas.list': { params: { refresh?: boolean }; result: AccountQuota[] };
  'quotas.configure': { params: { accountId: AccountId; enabled: boolean }; result: AccountQuota[] };
  /** The recommended plugins, then every one installed from a URL, rejected ones included. */
  'plugins.list': { params: Record<string, never>; result: PluginState[] };
  /**
   * Fetches the repository at `ref` (default `HEAD`) and reads its manifest.
   * Downloads no artifact and runs nothing. https URLs only.
   */
  'plugins.inspect': { params: { url: string; ref?: string }; result: PluginPreview };
  /** Installs exactly what a preview showed: that manifest, read at that commit. */
  'plugins.add': { params: { previewId: string }; result: PluginState };
  /** Installs a recommended plugin, or reinstalls one already added from a URL. */
  'plugins.install': { params: { id: string }; result: PluginState };
  'plugins.cancel': { params: { id: string }; result: PluginState };
  'plugins.uninstall': { params: { id: string }; result: PluginState };
  'plugins.accounts': { params: { id: string; refresh?: boolean }; result: PluginPool[] };
  'plugins.accountAction': {
    params: { id: string; provider: string; action: 'add' | 'switch' | 'remove'; email?: string };
    result: PluginPool[];
  };
  /**
   * The first frame. `token` is the core token or a session token; `grant` is
   * a pairing grant, exchanged here for a session whose token comes back in
   * `session` and is what this client says hello with from then on. One of the
   * two, never both.
   */
  hello: {
    params: {
      token?: string;
      grant?: string;
      protocolVersion: number;
      client: { name: string; version: string };
    };
    result: {
      core: CoreInfo;
      principal: Principal;
      session?: { id: string; token: string };
      /** The one thread an `agent` reaches. */
      threadId?: ThreadId;
    };
  };

  // -- The agent's own methods: the CLI, and the owner's UI behind the same surfaces.

  /** Where the calling thread is. */
  'agent.where': { params: { threadId: ThreadId }; result: AgentWhere };
  /**
   * Show something in the thread's right panel. Every client subscribed to the
   * thread receives `panel.requested`; `shown` says whether one was. The core
   * checks a path exists inside the working directory and a url is http(s),
   * and refuses by name otherwise.
   */
  'panel.open': { params: { threadId: ThreadId; surface: PanelSurface }; result: { shown: boolean } };
  /** The agent's task list, whole, as the tasks surface shows it. */
  'threads.tasks.set': { params: { threadId: ThreadId; tasks: AgentTask[] }; result: ThreadActivity };
  'threads.tasks.get': { params: { threadId: ThreadId }; result: AgentTask[] };

  /** The project's todo list, the thread naming the project. Done cards last. */
  'todos.list': { params: { threadId: ThreadId }; result: Todo[] };
  'todos.add': { params: { threadId: ThreadId; text: string }; result: Todo };
  /** A status or a text change. An agent moves a card to `claimed`; `done` is the user's confirmation. */
  'todos.update': { params: { threadId: ThreadId; todoId: string; status?: Todo['status']; text?: string }; result: Todo };
  'todos.remove': { params: { threadId: ThreadId; todoId: string }; result: { ok: true } };

  /** `git status` of the thread's working directory. Refused by name outside a repository. */
  'git.status': { params: { threadId: ThreadId }; result: GitStatus };
  /** One file's two sides. `ref` is what the working tree is compared to, HEAD by default. */
  'git.diff': { params: { threadId: ThreadId; path: string; ref?: string }; result: GitDiff };

  /** One directory of the working directory, `path` relative to it or empty for the root. Directories first. */
  'files.list': { params: { threadId: ThreadId; path?: string }; result: FileEntry[] };
  'files.read': { params: { threadId: ThreadId; path: string }; result: FileContent };
  /** The editor's save. Owner only: the agent has its own hands on the disk. */
  'files.write': { params: { threadId: ThreadId; path: string; text: string }; result: { bytes: number; modifiedAt: Timestamp } };

  /** A fresh one-time pairing link, `device` unless the role says otherwise. Owner only. */
  'pairing.grant': { params: { role?: PairingRole }; result: PairingGrant };
  /** Every paired client still able to connect. */
  'sessions.list': { params: Record<string, never>; result: PairedSession[] };
  /** Forget a paired client: its sockets close and its token opens nothing any more. Owner only. */
  'sessions.revoke': { params: { sessionId: string }; result: { ok: true } };
  /** Push credentials are owned by the authenticated pairing, never a caller-supplied session id. */
  'push.status': { params: Record<string, never>; result: { publicKey: string; subscribed: boolean } };
  'push.subscribe': { params: { endpoint: string; keys: { p256dh: string; auth: string } }; result: { ok: true } };
  'push.unsubscribe': { params: Record<string, never>; result: { ok: true } };
  'push.test': { params: Record<string, never>; result: { ok: true } };

  'projects.list': { params: Record<string, never>; result: Project[] };
  'projects.add': { params: { path: string; name?: string }; result: Project };
  /** Owner-only folder navigation on the machine running this core. */
  'projects.browse': {
    params: { path?: string };
    result: { path: string; parent: string | null; directories: { name: string; path: string }[] };
  };
  'projects.remove': { params: { projectId: ProjectId }; result: { ok: true } };
  /**
   * The files of a project a mention can name, ranked on the query: relative
   * paths with `/` separators, `.git`, `node_modules` and what the root
   * `.gitignore` names by plain name left out. `total` is the number of
   * matches, `files` the first `limit` of them (50 unless asked otherwise, 200
   * at most), and `capped` says the walk stopped at the file cap, so a match
   * may be missing.
   */
  'projects.files': {
    params: { projectId: ProjectId; query: string; limit?: number };
    result: { files: string[]; total: number; capped: boolean };
  };

  'providers.list': {
    params: Record<string, never>;
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  'providers.reload': {
    params: Record<string, never>;
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  /**
   * Claude, ACP, Codex and pi list models through a temporary agent process.
   * Results are kept until refresh, `providers.reload` or an account change.
   * For any other protocol they are the descriptor's models, with `probedAt`
   * the moment of the call.
   */
  'providers.probe': {
    params: { providerId: ProviderId; accountId: AccountId; refresh?: boolean };
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
  /** Current login state, used to rebuild cards after reconnecting. */
  'accounts.logins': { params: Record<string, never>; result: RpcEvents['account.login'][] };
  /** Stop the login process tree and wait for its exit. */
  'accounts.loginCancel': { params: { accountId: AccountId }; result: { ok: true } };
  /** One line into the running login's stdin, for a CLI that asks for a code. */
  'accounts.loginInput': { params: { accountId: AccountId; text: string }; result: { ok: true } };

  'threads.list': { params: { projectId?: ProjectId; includeArchived?: boolean }; result: ThreadSummary[] };
  /** Read the working branch's PR using the execution machine's GitHub CLI. */
  'threads.pullRequest': { params: { threadId: ThreadId }; result: ThreadSummary['pullRequest'] };
  'threads.create': {
    params: {
      projectId: ProjectId;
      providerId: ProviderId;
      accountId: AccountId;
      title?: string;
      cwd?: string;
      model?: string;
      effort?: string | null;
      speed?: string | null;
      permissionMode?: PermissionMode;
      /**
       * Start the thread in a git worktree of the project on a branch of its
       * own: `boite/<slug of the title>` unless `branch` names one. The core
       * runs `git worktree add` and refuses by name when the project is not a
       * git repository, git is missing, or the named branch already exists.
       * Excludes `cwd`.
       */
      worktree?: { branch?: string };
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
    result: { messages: Message[]; before: MessageId | null; turns?: Turn[] };
  };
  'threads.update': {
    params: {
      threadId: ThreadId;
      /** Select another account/provider for future turns in this conversation. */
      accountId?: AccountId;
      expectedSelectionVersion?: number;
      title?: string;
      model?: string | null;
      effort?: string | null;
      speed?: string | null;
      permissionMode?: PermissionMode;
    };
    result: ThreadSummary;
  };
  /**
   * A title written from the thread's first prompt and first answer. The
   * agent's own driver writes it when it can (Claude on one short call to a
   * small model, echo in memory), the core cuts the first line of the prompt
   * otherwise. Refused by name on a thread that has no prompt yet, or while
   * a title is already being written for it. The answer is the thread as
   * saved, `titleSource` saying which of the two wrote it.
   */
  'threads.retitle': { params: { threadId: ThreadId }; result: ThreadSummary };
  'threads.compact': { params: { threadId: ThreadId; expectedSelectionVersion?: number }; result: Turn };
  'threads.archive': { params: { threadId: ThreadId; archived?: boolean }; result: ThreadSummary };
  /** Pin or unpin (`pinned: false`) a thread. An archived thread keeps its pin for when it comes back. */
  'threads.pin': { params: { threadId: ThreadId; pinned?: boolean }; result: ThreadSummary };
  'threads.markRead': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Only subscribed threads stream message events to this connection. */
  'threads.subscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  'threads.unsubscribe': { params: { threadId: ThreadId }; result: { ok: true } };

  /** `attachments` are journalled with the prompt. Files become host paths; images use native provider payloads. */
  'turns.start': { params: { threadId: ThreadId; prompt: string; attachments?: Attachment[]; expectedSelectionVersion?: number; clientRequestId?: string }; result: Turn };
  'turns.stop': { params: { threadId: ThreadId }; result: { stopped: boolean } };

  /**
   * The requests still unanswered, in the order they were created; every thread
   * when `threadId` is omitted. A client that connects while a turn waits reads
   * the card here, since `permission.requested` only reached the sockets that
   * were subscribed when it fired.
   */
  'permissions.list': { params: { threadId?: ThreadId }; result: PermissionRequest[] };
  'permissions.answer': {
    params: { requestId: RequestId; decision: 'allow' | 'deny' };
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
  /**
   * Finished turns summed per bucket, provider and model. `edges` are 2 to 367
   * ascending timestamps chosen by the client, usually its local midnights, so
   * a day follows the reader's calendar whatever the core's time zone.
   */
  'usage.history': { params: { edges: Timestamp[] }; result: UsageHistory };

  'settings.get': { params: Record<string, never>; result: Settings };
  'settings.set': { params: Partial<Settings>; result: Settings };
  /** The keybindings file as last read: the path, the entries it names, and what it got wrong. */
  'keybindings.get': { params: Record<string, never>; result: Keybindings };
  /**
   * Writes one entry of the keybindings file: a chord, `mod+shift+k` style, or
   * null to leave the command with no key. The other entries stay as written.
   * A file that is not JSON is refused rather than overwritten.
   */
  'keybindings.set': { params: { command: KeybindingCommand; chord: string | null }; result: Keybindings };
  /** Takes entries out of the file so they fall back to the default: one command, or every one when omitted. */
  'keybindings.reset': { params: { command?: KeybindingCommand }; result: Keybindings };

  /**
   * The sessions the project's folder has on disk across every account whose
   * agent keeps transcripts (Claude Code: `<config dir>/projects/<folder>/*.jsonl`),
   * newest first. A file with no prompt is left out.
   */
  'imports.list': { params: { projectId: ProjectId }; result: ImportableSession[] };
  /**
   * One session read whole into a new thread: one finished turn per prompt,
   * the answers with their reasoning and tool calls, the session id set so
   * the next turn resumes it. Refused by name when the session is already a
   * thread, the account's agent keeps no transcripts, or the file has no prompt.
   */
  'imports.run': {
    params: { projectId: ProjectId; accountId: AccountId; sessionId: string };
    result: ThreadSummary;
  };
}

export type RpcMethodName = keyof RpcMethods;
export type RpcParams<M extends RpcMethodName> = RpcMethods[M]['params'];
export type RpcResult<M extends RpcMethodName> = RpcMethods[M]['result'];

export interface RpcEvents {
  'thread.activity': { threadId: ThreadId; activity: ThreadActivity };
  /** Subscribed threads only: the agent asked for something in the panel. */
  'panel.requested': { threadId: ThreadId; surface: PanelSurface; at: Timestamp };
  /** The project's whole list, after any change. */
  'todos.updated': { projectId: ProjectId; todos: Todo[] };
  'quotas.updated': AccountQuota[];
  /** One plugin after any change. A `url` plugin that comes back `not-installed` is gone from the list. */
  'plugins.updated': PluginState;
  /** A project `projects.add` created. A known path returns its project without one. */
  'project.added': Project;
  /** A project `projects.remove` deleted, after the `thread.removed` of each of its threads. */
  'project.removed': { projectId: ProjectId };

  'thread.created': ThreadSummary;
  'thread.updated': ThreadSummary;
  'thread.removed': { threadId: ThreadId };
  /** The agent's `/name` commands, whole, each time the list it reports changes. */
  'thread.commands': { threadId: ThreadId; commands: AgentCommand[] };

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
  /** The keybindings file changed on disk and was read again; the whole result, as `keybindings.get` would answer. */
  'keybindings.updated': Keybindings;
  /** A session was created or revoked: the list to re-read is `sessions.list`. */
  'sessions.updated': { sessionId: string; state: 'created' | 'revoked' };
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

/** Query parameter that carries a token when a UI is opened on one by hand. */
export const PAIR_QUERY_PARAM = 'token';
/** Query parameter that carries the one-time grant of a pairing link. */
export const GRANT_QUERY_PARAM = 'grant';
/** How long a pairing grant can wait to be opened. */
export const GRANT_TTL_MS = 10 * 60 * 1000;
/** Every role `pairing.grant` takes; anything else is refused by name. */
export const PAIRING_ROLES: readonly PairingRole[] = ['device', 'owner'];

export const CLIENT_NAMES = ['shell', 'pwa', 'cli', 'test', 'bench'] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

export { attachmentError } from './attachment-validation.ts';
