import type { AgentsRpcMethods, AgentsRpcEvents } from './agents';
import type { WorkflowsRpcMethods, WorkflowsRpcEvents } from './workflows';
import type { BrowserRpcMethods, BrowserRpcEvents } from './browser';
export * from './browser';
export * from './agents';
export * from './workflows';
export * from './workflow-plan';

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
  /**
   * Environment the agent's updater gets when it runs from this candidate: what
   * a launcher Boite skips would have set. Codex's npm package runs its binary
   * through a Node script that sets `CODEX_MANAGED_BY_NPM`, and `codex update`
   * without it cannot tell how it was installed.
   */
  updateEnv?: Record<string, string>;
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

/**
 * How an agent the user installed by their own means brings itself up to date.
 * Boite never downloads that agent: it asks the program its version, reads the
 * newest one where the agent publishes it, and runs the agent's own updater.
 */
export interface ProviderSelfUpdate {
  /** Arguments that print the installed version. The first `x.y.z` in the output is read. Default `--version`. */
  versionArgs?: string[];
  /** The npm package whose `latest` tag names the newest release. */
  latestNpm?: string;
  /** Arguments that print a JSON object carrying `latestVersion`, for an agent that checks by itself. */
  latestArgs?: string[];
  /**
   * Arguments of the agent's own updater. With neither `latestNpm` nor
   * `latestArgs` the newest version is unknown: nothing is announced, and the
   * updater still runs when the user asks for it.
   */
  args: string[];
}

/**
 * Where one agent stands against its newest release on this core's machine.
 * `managed` is a release Boite downloaded, updated through the install block
 * a Boite release pins. `self` is the user's own install, updated by the
 * agent's updater. `pending` is what a client shows: a newer version exists,
 * the user has not skipped it, and nothing is running.
 */
export interface HarnessUpdate {
  providerId: ProviderId;
  name: string;
  route: 'managed' | 'self';
  current: string | null;
  latest: string | null;
  pending: boolean;
  /** The version the user chose not to hear about again. A newer one asks again. */
  skipped: string | null;
  state: 'idle' | 'checking' | 'updating' | 'failed';
  /** Why the last check or update failed, null otherwise. */
  message: string | null;
  checkedAt: Timestamp | null;
}

export interface OsProfile {
  /** The provider is offered only when one of these resolves. */
  detect: { command?: string; file?: string };
  executable: ExecutableCandidate[];
  launch?: { args?: string[] };
  /** A release the core downloads on request. Absent when the agent ships another way. */
  install?: ProviderInstall;
  /** How the user's own install updates itself. Absent when the agent has no updater Boite can run. */
  update?: ProviderSelfUpdate;
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
  /**
   * The files that carry the login on this OS, in place of `auth.session`. An
   * empty list says the login can be kept outside any file here (Claude Code
   * uses the macOS Keychain): the `auth.session` files still read `ok` when
   * present, and their absence reads `unknown`, never `unauthenticated`.
   */
  session?: string[];
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
 * `accounts.loginInput`. With `terminal`, the same command is typed into a
 * shell the user sees instead (`accounts.loginTerminal`), for a CLI whose login
 * is an interactive menu a pipe cannot drive.
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
  /** Type `command` into a terminal the user drives rather than piping it. Only with `command`. */
  terminal?: boolean;
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
 * What an account with a directory of its own takes from the provider's own
 * profile, so a second login still runs the user's hooks, instructions, skills
 * and plugins. `variable` is one of the profile's isolation variables: its
 * default location is the source, the account's value of it the destination.
 * A directory is linked there, a file is copied again whenever the source
 * changed. A path that holds or contains a login file is refused at load time.
 */
export interface ProviderShare {
  variable: string;
  /** Relative to the variable's directory, no `..`. */
  paths: string[];
  /**
   * Files among `paths` whose copy names other files among `paths` by absolute
   * path, with those names: the copy points at the account's own file instead.
   * Codex keys the trust of each hook by the absolute path of `hooks.json`.
   */
  retarget?: Record<string, string[]>;
}

/**
 * Where the agent reads the user's own hooks, so Settings can say how many it
 * has. `events` is a JSON file, or every `.json` file of a directory, shaped
 * `{ "hooks": { "<Event>": [{ "hooks": [ ... ] }] } }`; each inner entry is one
 * hook. `modules` is a directory whose entries are each one module the agent
 * loads, hooks included (pi extensions, OpenCode plugins).
 */
export interface ProviderHookSource {
  /** An isolation variable, resolved like `ProviderShare.variable`. Absent means `path` starts with `~/`. */
  variable?: string;
  path: string;
  format: 'events' | 'modules';
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
  /** What an isolated account shares with the provider's own profile. Absent shares nothing. */
  shared?: ProviderShare[];
  /** Where the user's own hooks live. Only with `capabilities.hooks`. */
  hookSources?: ProviderHookSource[];
  /** Dialect fixes the driver of this protocol applies for this agent only. */
  quirks?: ProviderQuirk[];
  /** Native protocols may leave this empty; providers.probe supplies the account's catalog. */
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
  /** How Boite starts login: a piped command, ACP, a terminal or a device-code protocol. */
  login: false | { kind: 'command' | 'acp' | 'terminal' | 'device' };
  /** True when the provider cannot use its default login location. */
  alwaysIsolated: boolean;
  /** Where the managed install stands, null when this profile has no `install` block. */
  install: ProviderInstallState | null;
  /** True when this provider's agent writes thread titles: what Settings offers for `titleModel`. Missing on older cores. */
  titles?: boolean;
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

/** A read-only count. No redeemable identifiers reach the client. */
export interface QuotaResetCredits {
  availableCount: number;
  nextExpiresAt: Timestamp | null;
}

export interface QuotaCredits {
  /** A prepaid balance or a monthly spending budget, never interchangeable. */
  kind: 'balance' | 'budget';
  /** Null means the provider did not confirm automatic paid usage. */
  enabled: boolean | null;
  /** Provider units. Budgets are displayed as a percentage, not a wallet. */
  remaining: number | null;
  limit: number | null;
  unlimited: boolean;
}

export interface QuotaReading {
  windows: QuotaWindow[];
  resetCredits?: QuotaResetCredits;
  credits?: QuotaCredits;
}

/** Provider-reported limits, never inferred from Boite's token ledger. */
export interface AccountQuota extends QuotaReading {
  /** Account id, or `quota:antigravity-cli` for the opt-in local CLI quota source. */
  accountId: AccountId;
  providerId: ProviderId;
  providerName: string;
  label: string;
  enabled: boolean;
  status: 'ready' | 'unavailable' | 'unsupported' | 'disabled';
  /** A host's last observation, rather than a fresh account snapshot. */
  source?: 'observation';
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
  /** Precheck Worktree in new drafts. An absent value means off; existing drafts keep their choice. */
  worktreeDefault?: boolean;
  /**
   * The folder holds a `.git`, read on every answer rather than stored: the
   * test `threads.create.worktree` applies. Absent from a core older than this
   * field, which a client reads as unknown and keeps the worktree switch for.
   */
  repository?: boolean;
  /**
   * `drafts` on the one project `projects.drafts` made in the machine's
   * Documents folder, read from the path on every answer like `repository`.
   * A thread started there without a `cwd` gets a folder of its own inside it.
   * Absent on every other project and from a core older than this field.
   */
  kind?: 'drafts';
  /**
   * Put away with `projects.archive`: out of the sidebar, its threads and their
   * processes left as they were. A new thread in it brings it back. Absent when
   * false and from a core older than this field.
   */
  archived?: boolean;
  /**
   * How many of its own threads are archived, sub-threads left out, counted on
   * every answer; `project.updated` carries the new count when one is archived
   * or restored. Absent when none and from a core older than this field.
   */
  archivedThreads?: number;
  /**
   * The project's folder is gone from the disk: deleted, moved or renamed
   * since it was added. Read on every answer like `repository`, and
   * `project.updated` follows when it changes. A thread cannot start there
   * until the folder is back; removing the project still works. Absent while
   * the folder is there, while the disk gave no clear answer (a share whose
   * host sleeps) and from a core older than this field.
   */
  missing?: boolean;
  /**
   * What the sidebar draws in place of the project's initial, detected from
   * its folder after it was added and on `projects.refreshIcon`, never while a
   * list is answered. An `image` carries only its version: the bytes come
   * from `projects.icon`, once per version, so a list stays a few bytes per
   * project. Absent when nothing was found, before the first detection and
   * from a core older than this field.
   */
  icon?: ProjectIcon;
}

/**
 * The stacks a project can be recognised by when its folder holds no logo,
 * each drawn by the UI as a small mark. A core only ever names one of these.
 */
export const TECH_ICON_IDS = [
  'unity', 'unreal', 'godot', 'flutter', 'dart', 'electron', 'next', 'nuxt', 'svelte', 'angular',
  'react', 'android', 'swift', 'rust', 'go', 'python', 'dotnet', 'java', 'cpp', 'node',
] as const;
export type TechIconId = (typeof TECH_ICON_IDS)[number];

export type ProjectIcon =
  /** A logo, favicon or app icon read from the folder; `version` changes with its bytes. */
  | { kind: 'image'; version: string }
  /** No image, but the folder reads as this stack. */
  | { kind: 'tech'; id: TechIconId };

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'yolo' | 'plan' | 'dontAsk';

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

/**
 * How long the provider keeps the conversation's prompt prefix cached after the
 * last turn. A request inside that time reads the prefix from the cache at a
 * fraction of the input price; after it, the provider processes the whole
 * context again. Every hit restarts the clock, so `at` is the end of the turn
 * that last touched the cache, not the turn that first wrote it.
 */
export interface PromptCache {
  /** When the turn that last used the cache finished. */
  at: Timestamp;
  /** Seconds the prefix is kept after `at`. */
  ttlSeconds: number;
  /**
   * Seconds the provider may keep it on a best-effort basis beyond
   * `ttlSeconds` (OpenAI: up to an hour under low load). Absent when the
   * lifetime is fixed.
   */
  maxSeconds?: number;
  /**
   * `reported`: the agent's own usage named the lifetime of this request
   * (Claude's `cache_creation.ephemeral_1h_input_tokens`). `documented`: the
   * provider's published lifetime for what this agent sends.
   */
  source: 'reported' | 'documented';
  /** Tokens the last turn read from the cache, zero on a turn that started cold. */
  readTokens: number;
  /** The model and account the cache belongs to: another model or account starts cold. */
  model: string | null;
  accountId: AccountId;
}

/** Latest observed execution event of the current turn, never a synthetic heartbeat. */
export interface ThreadProgress {
  turnId: TurnId;
  phase: 'starting' | 'thinking' | 'compacting' | 'retrying' | 'tool' | 'working' | 'waiting';
  detail: string | null;
  at: Timestamp;
  /** Latest provider signal, including status notifications that do not advance activity. */
  providerAt?: Timestamp | null;
}

export interface ThreadSummary {
  /** Core-owned delegation relationship. Absent on ordinary conversations. */
  parentThreadId?: ThreadId | null;
  /** Last accepted user message, independent of assistant activity and renames. */
  lastUserMessageAt?: Timestamp | null;
  pullRequest?: { number: number; url: string; state: 'OPEN' | 'CLOSED' | 'MERGED' } | null;
  id: ThreadId;
  projectId: ProjectId | null;
  /** Only persistent agent sessions have no project. */
  agentSessionId?: string;
  title: string;
  titleSource: TitleSource;
  /** Durable title revision and whether the first answer should resolve a vague initial subject. Missing on older cores. */
  titleState?: { version: number; needsRefinement: boolean };
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
  /** Only automatically created temporary branches may be named by the title model. */
  branchNamingPending?: boolean;
  permissionMode: PermissionMode;
  status: ThreadStatus;
  /**
   * When the turn now running started, what a sidebar row counts its time
   * from. Also set while the turn waits on the user. Null when no turn runs;
   * missing on older cores.
   */
  runningSince?: Timestamp | null;
  /** In memory only, cleared at turn end/restart. Missing on older cores. */
  progress?: ThreadProgress | null;
  /**
   * What the agent still runs in the background, a monitor or a shell it left
   * going past its turn: the kind of each task and when the oldest started,
   * so a row can say the thread is not finished. The tasks themselves are
   * `Thread.background`. Null when nothing runs; missing on older cores.
   */
  backgroundWork?: { kinds: BackgroundTask['kind'][]; since: Timestamp } | null;
  /**
   * A move asked for while the thread's turn ran, applied when that turn
   * ends (`threads.move`, `agent.move`). In memory only: null after a core
   * restart, and missing on older cores.
   */
  pendingMove?: PendingMove | null;
  /** Answers accepted by the core, waiting for the running agent or the next turn. In memory only. */
  pendingAnswers?: string[];
  unread: boolean;
  archived: boolean;
  /** Kept above the other threads of its project in the sidebar, whatever runs. */
  pinned: boolean;
  /** Provider session id once the first turn has run; used to resume. */
  sessionId: string | null;
  /**
   * The entry of `sessionId`'s native transcript the next turn resumes at,
   * forking the rest away: set by `threads.rewind` and `threads.fork` on a
   * driver that can cut its own transcript (Claude), cleared once the agent
   * answered on the forked session. Null or absent means resume the whole
   * session. Clients have nothing to do with it.
   */
  sessionResumeAt?: string | null;
  /** Changes when the account changes; native sessions never cross this boundary. */
  sessionGeneration?: number;
  /** Optimistic revision of the selection for future turns. Missing on older clients means zero. */
  selectionVersion?: number;
  load: ThreadLoad | null;
  /** The context meter, written at the end of every turn whose agent reports its usage. */
  context: ContextUse | null;
  /**
   * The prompt cache the last turn left behind, null when the provider's
   * lifetime is unknown or no turn has finished. Missing on older cores.
   */
  promptCache?: PromptCache | null;
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
  projectId: ProjectId | null;
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
  'providerId' | 'accountId' | 'model' | 'effort' | 'speed' | 'permissionMode' | 'sessionId' | 'sessionResumeAt'
> & {
  sessionGeneration: number;
  selectionVersion: number;
  /**
   * `background`: the agent resumed on its own after background work it
   * started finished; the turn carries no prompt of the user's.
   * `resume`: the core restarted over a running turn and opened this one so
   * the agent carries on (`docs/restart-handoff.md`).
   */
  operation?: 'compact' | 'coordination' | 'delegation' | 'background' | 'resume';
  /** A `compact` the core opened by the `autoCompact` setting, not one the user asked for. */
  automatic?: true;
};

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
  /**
   * Where the agent's native transcript stood when this turn ended: the
   * session it ran on and the id of the last entry it wrote there (Claude: the
   * uuid of the last main-chain message). What `threads.rewind` and
   * `threads.fork` resume at. Absent on drivers that report none and on turns
   * finished before it was recorded.
   */
  checkpoint?: { sessionId: string; entry: string } | null;
}

/** A thread status that means one of its turns is still under way. */
export function threadActive(status: ThreadStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}

/**
 * Whether a finished turn is worth a notification, for the core's Web Push and
 * a client's own toast alike. A delegated agent's result goes to its parent,
 * whose next turn reports it; a parent's turn that ends while `activeChildren`
 * of its agents still work is not the answer yet; a persistent agent's work is
 * read in the agents inbox, so only its failures notify; compacting the
 * context is housekeeping. A stop is the user's own doing. Requests that wait
 * for an answer are notified whatever the thread.
 */
export function notifiesOnFinish(
  thread: Pick<ThreadSummary, 'parentThreadId' | 'agentSessionId'>,
  turn: Pick<Turn, 'status' | 'execution'>,
  activeChildren: number,
): boolean {
  if (turn.status !== 'done' && turn.status !== 'error') return false;
  if (thread.parentThreadId) return false;
  if (turn.execution?.operation === 'compact') return false;
  if (turn.status === 'error') return true;
  if (thread.agentSessionId) return false;
  return activeChildren === 0;
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

export { IMAGE_MIME_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, RPC_MAX_FRAME_BYTES } from './attachment-limits.ts';
import type { ImageMimeType } from './attachment-limits.ts';
export type { ImageMimeType } from './attachment-limits.ts';

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

/** A user-selected element. Page text is untrusted context, never instructions. */
export interface PreviewReference {
  id: string;
  url: string;
  selector: string;
  shadowPath?: string[];
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
  surfaceId?: string;
  /** UTF-16 offsets of the visible mention in the prompt/displayText. */
  mention?: { start: number; end: number };
}

export { PREVIEW_REFERENCES_PER_TURN, previewReferencesError, previewPrompt } from './preview';

/** One end of a thread move: the project and the folder the agent works in. */
export interface MoveEnd {
  projectId: ProjectId;
  /** The project's display name when the move happened. */
  name: string;
  cwd: string;
}

/**
 * Carried by the first user message after `threads.move`: where the thread
 * came from and where it works now. `note` is the plain sentence the core
 * put before the prompt for the agent; the UI shows a marker line instead.
 * Several moves before that message keep the first `from` and the last `to`.
 * With `by: 'agent'` it rides on a system message instead: the agent moved
 * its own thread (`agent.move`), nothing was put before a prompt, and `note`
 * is only what a fresh session's history says about it.
 */
export interface MoveNotice {
  from: MoveEnd;
  to: MoveEnd;
  note: string;
  by?: 'agent';
  /** Epoch milliseconds of the last move. */
  at: number;
}

/** A move waiting for the thread's turn to end (`ThreadSummary.pendingMove`). */
export interface PendingMove {
  projectId: ProjectId;
  /** The target project's name, for the row's "Moves to ... after this turn". */
  project: string;
  /** Who asked: the user from a menu or a drag, or the agent with `boite thread move`. */
  by: 'user' | 'agent';
  /** Epoch milliseconds of the request. */
  at: number;
}

/** Outgoing files live on disk above the inline attachment limit. */
export const ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;
export interface ArtifactContent { url: string; bytes: number; mimeType: string; name: string; }

export type MessagePart =
  | { type: 'text'; text: string; complete?: boolean; displayText?: string; previewReferences?: PreviewReference[]; activity?: { kind: 'goal' | 'loop'; iteration: number }; moved?: MoveNotice; startedBy?: ThreadLink; started?: ThreadLink }
  /** An image the user sent with the prompt, journalled with the message. */
  | { type: 'image'; mimeType: ImageMimeType; data: string; alt: string | null }
  | { type: 'file'; mimeType: string; data: string; name: string | null }
  /** An immutable published file; resolve its bytes with artifacts.read, never as a disk path. */
  | { type: 'artifact'; id: string; mimeType: string; bytes: number; name: string }
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
      /** A command's exit code when the provider reports it. Absent on older rows and other tools. */
      exitCode?: number | null;
      /** Provider-reported child activity. These are not Boite thread IDs or team budget entries. */
      nativeAgents?: NativeAgentUpdate[];
      /** What the call produced or changed, under the input and the output. Absent on a journal row written before documents existed. */
      documents?: ToolDocument[];
      /** Stamped by the core when the card first shows up, for every driver. Absent on older rows. */
      startedAt?: Timestamp;
      /** Stamped by the core when the status leaves `running`. */
      finishedAt?: Timestamp | null;
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
      /** Asked without stopping: see `QuestionRequest.async`. */
      async?: boolean;
    }
  /**
   * The agent compacted its context mid-turn: what it held before, what is
   * left after when it says so. Drawn as a divider in the timeline.
   */
  | { type: 'compaction'; trigger: 'auto' | 'manual'; preTokens: number | null; postTokens: number | null }
  /**
   * One of the user's own hooks ended the turn: it blocked the prompt, or told
   * the agent to stop. `event` is the agent's own name for the hook event. A
   * hook that denied a tool call shows on that tool's card instead.
   */
  | { type: 'hook'; event: string; outcome: 'blocked' | 'stopped'; message: string }
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
  /** The latest 100 memory notices, oldest first, including those missed while disconnected. */
  memoryEvents?: MemoryEvent[];
  activity?: ThreadActivity;
  /**
   * Set when `threads.get` answered an `after`: `messages` starts at this
   * message, `turns` are theirs, and `messagesBefore` says nothing. The caller
   * keeps every message it held before this one.
   */
  messagesFrom?: MessageId;
  /** The last `MESSAGE_PAGE` messages of the thread, oldest first. Older ones come from `messages.list`. */
  messages: Message[];
  /**
   * What the agent of this thread last said it takes as `/name`. Empty until a
   * session of this core reported them: the list is the agent's, kept in
   * memory, and `thread.commands` follows every change.
   */
  commands: AgentCommand[];
  /**
   * What the agent still runs in the background (`thread.background`). Kept in
   * memory like `commands`; missing on older cores.
   */
  background?: BackgroundTask[];
  /**
   * The oldest message `messages` carries, when the thread has older ones behind
   * it; null when this page is the whole thread. It is the cursor `messages.list`
   * takes as `before`.
   */
  messagesBefore: MessageId | null;
  /** The turns `messages` refers to, plus any still queued or running; never the whole history. */
  turns: Turn[];
}

/** What `threads.rewind` answers: the thread after the cut and the removed message, ready for the composer. */
export interface ThreadRewind {
  /** As `threads.get` would answer now: the last page of what is left. */
  thread: Thread;
  /** What the user typed, without the page context a preview reference added to it. */
  prompt: string;
  /** The images and files the removed message carried, as `turns.start` takes them. */
  attachments: Attachment[];
  /** The page elements the removed message referred to, empty when none. */
  previewReferences: PreviewReference[];
  /**
   * How the agent forgets the removed part. `native`: the driver resumes its
   * own transcript at the cut. `seeded`: the next turn starts a fresh session
   * carrying the kept history, as a change of account does.
   */
  session: 'native' | 'seeded';
  /** File changes restored before the cut. Missing on older cores. */
  files?: { status: 'restored' | 'unchanged' | 'unavailable'; count: number; reason?: string };
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
  /**
   * The agent did not stop for it. The thread is not `waiting`, the card
   * outlives its turn, and the answer reaches the agent as a steer when a turn
   * is running or as the next prompt when none is.
   */
  async?: boolean;
  createdAt: Timestamp;
}

/**
 * Work the agent left running beyond one tool call: a shell started in the
 * background, a subagent, a monitor or a workflow. The list is the agent's
 * own, whole, each time it changes, and lives as long as the agent process.
 */
export interface BackgroundTask {
  id: string;
  kind: 'shell' | 'agent' | 'monitor' | 'workflow' | 'other';
  description: string;
  /** The tool call that started it, when the agent says so. */
  toolId: string | null;
  startedAt: Timestamp;
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

/** A thread with at least one process running now; what exited stays in `trace.get`. */
export interface ThreadResources {
  threadId: ThreadId;
  title: string;
  status: ThreadStatus;
  live: ProcessRecord[];
  /** The latest sample of the whole tree, the same one `ThreadSummary.load` carries. */
  load: ThreadLoad;
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
  running: { turnId: TurnId; threadId: ThreadId; startedAt: Timestamp }[];
  queued: { turnId: TurnId; threadId: ThreadId; position: number; queuedAt: Timestamp }[];
}

export type MemoryState = 'ok' | 'critical';

export interface MemoryStatus {
  state: MemoryState;
  agentBytes: number;
  availableBytes: number | null;
  /** All zero when protection is off; usage readings remain available. */
  limits: { budgetMb: number; threadMemoryCapMb: number; memoryReserveMb: number };
}

interface MemoryEventBase {
  threadId: string | null;
  pid?: number;
  exe?: string;
  bytes?: number;
  state: MemoryState;
  at: number;
  /** Insert after the parts present when this notice arrived, including after reload. */
  anchor?: { messageId: MessageId; partIndex: number };
}

export type MemoryKillReason = 'thread-quota' | 'budget' | 'machine';

export type MemoryEvent = MemoryEventBase & (
  | { kind: 'killed'; reason: MemoryKillReason; limitBytes: number }
  | { kind: 'thread-cap' | 'budget' | 'pressure' }
);

/** Per-core consent. Installation identifiers never cross RPC. */
export interface TelemetryState {
  mode: 'off' | 'basic' | 'enhanced';
  configured: boolean;
  pendingDeletion: boolean;
}

export const DEFAULT_THREAD_DELETION_RETENTION_DAYS = 30;

/** A recoverable conversation, with the time its whole family was deleted. */
export interface DeletedThreadSummary extends ThreadSummary {
  deletedAt: number;
}

export interface Settings {
  /** Days after deletion before history is purged. 0 keeps it indefinitely. Missing means 30. */
  threadDeletionRetentionDays?: number;
  /** New worktrees only. Missing means project mode; existing checkouts keep their path. */
  worktreeStorage?: WorktreeStorage;
  /** Exact browser origins allowed to connect alongside the shell and this core's own origin. */
  browserOrigins?: string[];
  /** HTTPS origin served by the reverse proxy, used in phone pairing links. */
  publicUrl?: string | null;
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
  /** Share of physical RAM for all agents, an integer from 10 to 90. Default 60. */
  agentMemoryBudgetPercent: number;
  /**
   * Memory ceiling for one thread's whole process tree, in megabytes. 0 means
   * half the effective budget, rounded down to 256 MB. An explicit cap cannot
   * exceed the budget. The kernel safety net sits 10% above this quota on Windows.
   */
  threadMemoryCapMb: number;
  /** Memory kept available in MB. 0 uses the larger of 10% of physical RAM and 3 GB. */
  memoryReserveMb: number;
  /** Automatic memory stops and Windows allocation caps. Missing means enabled. */
  memoryProtection?: boolean;
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
  /**
   * A process a thread left running after its turn, whose parent has exited, is
   * stopped once the thread has been idle for a few seconds: what an interrupted
   * or refused command started and nobody is left to stop. Windows only, where
   * the job reports grandchildren. Missing on older cores, which read as on.
   */
  reapOrphans?: boolean;
  /**
   * The core updates its agents by itself: checked ten minutes after start,
   * or six hours after the reading kept from the last run when that is later,
   * then every six hours, each one updated once no turn of its provider is in
   * flight. It needs no client connected, which is how a server stays current.
   */
  autoUpdateHarnesses: boolean;
  /**
   * Agents without asynchronous questions of their own are told about
   * `boite ask` at the start of a session, so they can ask without stopping.
   * Missing on older cores, which read as on.
   */
  asyncQuestions?: boolean;
  /**
   * The model that writes every thread's title after its first answer. Null
   * or missing: each thread's own provider on its small model
   * (`defaultTitleModel`), under the thread's account. A provider that can no
   * longer write one falls back to that too.
   */
  titleModel?: TitleModel | null;
  /**
   * When the core compacts a conversation by itself, between two turns. Null
   * or missing: never, each agent keeps its own behaviour. Missing on older cores.
   */
  autoCompact?: AutoCompact | null;
}

export type WorktreeStorage =
  | { mode: 'project'; directory: string | null }
  | { mode: 'shared'; directory: string };

/** One provider's model, picked in Settings to write thread titles. */
export interface TitleModel {
  /** A provider whose summary says `titles`. */
  providerId: ProviderId;
  /** A model id that provider lists. */
  model: string;
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
  'terminal',
  'reopen-thread',
  'copy-answer',
  'find',
  'thread-1',
  'thread-2',
  'thread-3',
  'thread-4',
  'thread-5',
  'thread-6',
  'thread-7',
  'thread-8',
  'thread-9',
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
  /** SHA-256 of the loaded JavaScript entry bundle, captured before serving requests. */
  bundleHash?: string;
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
  projectId: ProjectId | null;
  projectPath: string | null;
  /** The thread's working directory: the project, or its worktree. */
  cwd: string;
  branch: string | null;
  worktree: boolean;
  providerId: ProviderId;
  model: string;
}

/** One project of `agent.projects`: what an agent names in `delegate spawn --project` or `thread move`. */
export interface AgentProject {
  id: ProjectId;
  name: string;
  path: string;
  /** The folder holds a `.git`: `--worktree` works there. */
  repository: boolean;
  /** The drafts project, where a thread gets a new folder of its own. */
  drafts: boolean;
  /** The calling thread's own project. */
  current: boolean;
}

/** The answer of `agent.addProject`: the project, and whether this call registered it. */
export interface AgentProjectAdded extends AgentProject {
  /** False when the folder was already a project; nothing changed then. */
  added: boolean;
}

/**
 * One end of `agent.spawn`. On the new thread's first prompt as `startedBy`
 * (the thread whose agent started it), and on a system line of the starting
 * thread as `started` (the thread it started).
 */
export interface ThreadLink {
  threadId: ThreadId;
  title: string;
  projectId: ProjectId;
  /** The project's name when the link was made. */
  project: string;
}

/** What `agent.spawn` answers: the new thread, its first turn and how to reach its agent. */
export interface AgentSpawn {
  thread: ThreadSummary;
  turnId: TurnId;
  /** Its address for `collaboration.send`. */
  address: AgentAddress;
  /** The project's name. */
  project: string;
}

/** What `agent.move` answers: where the thread goes, and when. */
export interface AgentMove {
  threadId: ThreadId;
  projectId: ProjectId;
  /** The target project's name. */
  project: string;
  /** The target project's folder. */
  projectPath: string;
  /**
   * The folder the next turn starts in: known now for a plain project folder,
   * null while a turn runs and the move will make a worktree or a draft folder.
   */
  cwd: string | null;
  /** `turn-end`: a turn runs and the move waits for it to end. `done`: the thread moved on the spot. */
  when: 'turn-end' | 'done';
  /** Background work the agent left running stops when the move happens. */
  stopsBackground: boolean;
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
  | { kind: 'browser'; url: string; artifact?: { path: string; port: number } }
  | { kind: 'trace' }
  | { kind: 'tasks' }
  | { kind: 'workflow'; runId?: string };

export const PANEL_SURFACE_KINDS = ['file', 'files', 'diff', 'browser', 'trace', 'tasks', 'workflow'] as const;
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

/** A card is a line, not a document: the whole list travels on every change. */
export const TODO_TEXT_MAX = 2000;

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

/** Maximum full name of a Git branch created by Boite, including prefix and collision suffix. */
export const BRANCH_NAME_MAX = 48;

/**
 * One linked worktree of a project's repository, as `worktrees.list` reads it
 * from `git worktree list`: the core's own in its configured storage and any the
 * user added by hand, never the main checkout. What it says is what a removal
 * would lose.
 */
export interface WorktreeEntry {
  /** The directory, in the form of the machine running the core. */
  path: string;
  /** The branch checked out there without `refs/heads/`, null on a detached HEAD. */
  branch: string | null;
  /** `git status` lists something: a modified, staged or untracked file. False when `missing`. */
  dirty: boolean;
  /**
   * HEAD is reachable from no local branch or remote-tracking ref other than
   * the worktree's own branch: removing the worktree and its branch loses
   * those commits. A branch with no commit of its own is not unmerged.
   */
  unmerged: boolean;
  /** Git still lists the worktree but its directory is gone. */
  missing: boolean;
  /**
   * The thread whose working directory is this worktree or a folder inside
   * it, compared without case on Windows. A live thread wins over an archived
   * one; null when no thread stands there.
   */
  threadId: ThreadId | null;
  threadTitle: string | null;
  /** That thread is archived: the worktree can be removed. False when `threadId` is null. */
  threadArchived: boolean;
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
  /**
   * The local model in use: a `SPEECH_CATALOGUE` id or the `custom-<12 hex>` of
   * one added from a link. `modelPath`, when set, wins over it. A `speech.configure`
   * that leaves it out keeps the current one.
   */
  model: string;
}
/** A local model this core offers or holds. */
export interface SpeechModel {
  id: string;
  kind: 'catalogue' | 'custom';
  /** The catalogue's name, or the file name of the link a custom model came from. */
  name: string;
  /** The catalogue size, or what a custom download holds; 0 while unknown. */
  bytes: number;
  /** Catalogue only. */
  tier?: SpeechModelTier;
  /** Custom only: the host it came from. The link itself stays on the core. */
  host?: string;
  installed: boolean;
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
  /** 0 while a link's server has not said how big the file is. */
  totalBytes: number;
  error: string | null;
  canInstallRuntime: boolean;
  /** The catalogue, then every model added from a link. */
  models: SpeechModel[];
  /** The model a running download is for, null when none runs. */
  downloading: string | null;
  /** The managed runtime predates the resident engine; `speech.install` fetches it again (8 MB). */
  runtimeOutdated: boolean;
}
export const SPEECH_MAX_SECONDS = 120;
export const SPEECH_MAX_BYTES = 44 + 16000 * 2 * SPEECH_MAX_SECONDS;

export type CoordinationMode = 'off' | 'brief' | 'team';
export interface CoordinationConfig {
  mode: CoordinationMode;
  resources: string;
  remote: boolean;
  paused: boolean;
}
/** Default communication for ordinary threads; explicit owner settings take precedence. */
export function defaultCoordinationConfig(): CoordinationConfig {
  return { mode: 'brief', resources: '', remote: true, paused: false };
}
export interface AgentAddress { coreId: string; threadId: ThreadId }
export interface AgentContact extends AgentAddress {
  title: string;
  machine: string;
  resources: string;
  status: ThreadStatus;
  mode: CoordinationMode;
  /** The project's name. Missing on older cores. */
  project?: string;
  /** Provider and model, as `claude claude-opus-5-5`. Missing on older cores. */
  agent?: string;
  /** The worktree branch the thread works on, when it has one. Missing on older cores. */
  branch?: string | null;
  /** Last activity: a message, a turn or a change of state. Missing on older cores. */
  activeAt?: Timestamp;
}
/** A contact whose title, project, branch, model, resources or chat matched a search. */
export interface AgentMatch extends AgentContact {
  /** Which fields matched, best first. */
  matched: ('title' | 'project' | 'branch' | 'agent' | 'resources' | 'chat')[];
  /** Up to three short excerpts of the chat around a match. */
  excerpts: string[];
}
/** One entry of another agent's conversation as `collaboration.read` returns it. */
export interface AgentTranscriptEntry {
  id: string;
  role: 'user' | 'assistant' | 'system';
  at: Timestamp;
  /** Text only, cut at 4,000 characters. */
  text: string;
  /** The tools the agent called in this message, by name, in order. */
  tools: string[];
}
export interface AgentTranscript {
  contact: AgentContact;
  entries: AgentTranscriptEntry[];
  /** Older entries exist before the first one returned; pass its `at` as `before`. */
  more: boolean;
}
export interface AgentLetter {
  /** Authenticated source of delegation mail. Older coordination mail is agent-authored. */
  origin?: 'user' | 'agent' | 'result';
  id: string;
  from: AgentContact;
  to: AgentAddress;
  toTitle: string;
  toProject?: string;
  toMachine?: string;
  text: string;
  replyTo: string | null;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  status: 'queued' | 'received' | 'delivered' | 'uncertain' | 'expired' | 'rejected';
  error: string | null;
}
/** Public contact card. No owner token or private signing key crosses a core. */
export interface CoordinationPeer {
  coreId: string;
  name: string;
  url: string;
  publicKey: string;
  /** Local owner permission for agents on this peer to read this core's threads. Missing means denied. */
  readThreads?: boolean;
  /** Route through an owner app connected to both cores; never dial its loopback address on another host. */
  viaClient?: boolean;
}
/** Signed coordination response carried unchanged through the owner's app. */
export interface CoordinationBridgeResponse { status: number; body: string; signature: string }
export interface CoordinationView {
  self: AgentAddress;
  config: CoordinationConfig;
  messages: AgentLetter[];
  sent: number;
  /** Null: no limit. Older cores send a number. */
  sendLimit: number | null;
  wakes: number;
  /** Null: no limit. Older cores send a number. */
  wakeLimit: number | null;
}

/** Owner-selected routes. Agents name a profile, never arbitrary credentials or permissions. */
export interface DelegationProfile {
  id: string;
  name: string;
  providerId: ProviderId;
  accountId: AccountId;
  model: string;
  effort: string | null;
}
export interface DelegationConfig {
  enabled: boolean;
  paused: boolean;
  profiles: DelegationProfile[];
}
/**
 * On from the first turn: a conversation delegates to its own model with
 * nothing to set up. Owner profiles only add other models.
 */
export const DEFAULT_DELEGATION_CONFIG: DelegationConfig = {
  enabled: true, paused: false, profiles: [],
};
/** The profile every conversation has without configuring one: its own harness, account, model and effort. */
export const CONVERSATION_PROFILE_ID = 'conversation';
export interface DelegatedAgent {
  thread: ThreadSummary;
  profileId: string;
  task: string;
  lastTurn: Turn | null;
  /** Bounded final answer, without tool payloads or a summarization model call. */
  result: string | null;
}
export interface DelegationView {
  rootThreadId: ThreadId;
  config: DelegationConfig;
  agents: DelegatedAgent[];
  /** Native children reported by this conversation's provider, including earlier message pages. */
  nativeAgents: NativeAgent[];
  messages: AgentLetter[];
  turnsUsed: number;
  usage: Usage;
}

export interface NativeAgentUpdate {
  id: string;
  name?: string;
  task?: string;
  model?: string;
  status: 'running' | 'done' | 'error' | 'stopped' | 'unknown';
  result?: string;
}
export interface NativeAgent extends NativeAgentUpdate {
  toolId: string;
  startedAt: Timestamp;
}
export { nativeAgentsOfTool, collectNativeAgents } from './native-agents.ts';

/** A brain lives on the core's machine. Detected plugins are not installed by Boite. */
export interface BrainConfig {
  path: string | null;
  enabled: boolean;
  /** Pull only. An interval of 0 disables periodic pulls. Defaults to off. */
  autoPull?: { onStartup: boolean; intervalMinutes: number };
  /** Link the root AGENTS.md into user-level harness profiles on this machine. */
  globalInstructions?: boolean;
  /** Inject Boite's guide once per agent session, even without a brain. Defaults to on. */
  boiteGuide?: boolean;
}

export interface BrainLink {
  name: string;
  path: string;
  state: 'linked' | 'existing' | 'blocked';
  error: string | null;
}

export interface BrainEntry {
  kind: 'instructions' | 'skill' | 'plugin';
  path: string;
  name: string;
  description: string;
  error: string | null;
}

export interface BrainStatus {
  config: BrainConfig;
  entries: BrainEntry[];
  problems: string[];
  git: { branch: string | null; upstream: string | null; ahead: number; behind: number; dirty: boolean } | null;
  lastSync: number | null;
  links?: BrainLink[];
}

/**
 * What one hook run came to. `skipped` is a hook the agent has but will not
 * run, Codex's untrusted or modified ones.
 */
export type HookOutcome = 'ok' | 'blocked' | 'failed' | 'stopped' | 'skipped';

/** One hook run that did not simply pass. The core keeps the newest ones in memory, since it started. */
export interface HookRun {
  at: Timestamp;
  providerId: ProviderId;
  accountId: AccountId | null;
  threadId: ThreadId | null;
  /** The agent's own name for the event: `PreToolUse`, `userPromptSubmit`. */
  event: string;
  /** What the agent calls the hook, `PreToolUse:Bash`, or the file it comes from. */
  name: string;
  outcome: Exclude<HookOutcome, 'ok'>;
  /** What the hook or the agent said about it, at most 500 characters. */
  message: string | null;
}

/** One place the agent reads the user's hooks from, as Settings shows it. */
export interface HookSourceState {
  /** The path read, the home directory written `~`. */
  path: string;
  format: ProviderHookSource['format'];
  /** Hooks (`events`) or modules (`modules`) found there. Null when the path does not exist. */
  count: number | null;
  /** Why it could not be read, null when it was. */
  error: string | null;
}

/** An account with a directory of its own, and what it does not get from the provider's own profile. */
export interface HookShareState {
  accountId: AccountId;
  label: string;
  problems: { path: string; message: string }[];
}

export interface ProviderHooks {
  providerId: ProviderId;
  name: string;
  /** `capabilities.hooks`: the agent runs the hooks the user configured for it. */
  runsHooks: boolean;
  /** Boite sees each run (Claude, Codex); for the others only the configuration is known. */
  reports: boolean;
  sources: HookSourceState[];
  accounts: HookShareState[];
  /** Since `HooksStatus.since`. */
  runs: number;
  blocked: number;
  failed: number;
  skipped: number;
}

export interface HooksStatus {
  /** When this core started counting. */
  since: Timestamp;
  /** Every provider available on this core's machine. */
  providers: ProviderHooks[];
  /** Newest first, at most 50. */
  recent: HookRun[];
}

/**
 * A shell the core runs in a pseudo-terminal. Its id names what it belongs to:
 * `terminal:<threadId>` for a thread's, `login:<accountId>` for a sign-in.
 */
export interface TerminalState {
  id: string;
  /** Where the shell started. */
  cwd: string;
  /** What it printed lately, so a client that attaches late draws the same screen. */
  output: string;
  /** Last output event included in this snapshot; absent on older cores. */
  sequence?: number;
}

/** The server on one machine, independently of the desktop application's updater. */
export interface ServerUpdateStatus {
  mode: 'systemd' | 'docker' | 'manual';
  phase: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'waiting' | 'installing' | 'error';
  currentVersion: string;
  version: string | null;
  channel: 'stable' | 'nightly';
  publishedAt: string | null;
  checkedAt: Timestamp | null;
  received: number;
  total: number | null;
  error: string | null;
}

export interface RpcMethods extends AgentsRpcMethods, WorkflowsRpcMethods, BrowserRpcMethods {
  'core.shutdown': { params: Record<string, never>; result: { ok: true } };
  'core.updateStatus': { params: { refresh?: boolean }; result: ServerUpdateStatus };
  /** Confirm the version shown to the owner so a stale dialog cannot install another release. */
  'core.updateInstall': { params: { version: string }; result: ServerUpdateStatus };
  'core.updateCancel': { params: Record<string, never>; result: ServerUpdateStatus };
  'delegation.get': { params: { threadId: ThreadId }; result: DelegationView };
  'delegation.configure': { params: { threadId: ThreadId; config: DelegationConfig }; result: DelegationView };
  'delegation.spawn': { params: { threadId: ThreadId; profileId: string; task: string; title?: string; requestId: string }; result: DelegatedAgent };
  'delegation.send': { params: { threadId: ThreadId; toThreadId: ThreadId; text: string; requestId: string }; result: AgentLetter };
  'delegation.stop': { params: { threadId: ThreadId; agentId?: ThreadId }; result: { stopped: number } };
  'brain.status': { params: Record<string, never>; result: BrainStatus };
  'brain.configure': { params: BrainConfig; result: BrainStatus };
  /** Fetch, fast-forward and push existing commits. Never stage, stash, reset or force. */
  'brain.sync': { params: Record<string, never>; result: BrainStatus };
  /** Where each agent reads the user's hooks, what separate accounts miss of them, and the runs that did not pass. */
  'hooks.status': { params: Record<string, never>; result: HooksStatus };
  'collaboration.get': { params: { threadId: ThreadId }; result: CoordinationView };
  'collaboration.configure': { params: { threadId: ThreadId; config: CoordinationConfig }; result: CoordinationView };
  'collaboration.directory': { params: { threadId: ThreadId }; result: { agents: AgentContact[]; unavailable: string[] } };
  'collaboration.send': { params: { threadId: ThreadId; to: AgentAddress; text: string; replyTo?: string; requestId: string }; result: AgentLetter };
  /** Contacts on this core and linked cores whose title, project, branch, model, resources or chat contain every word of `query`. */
  'collaboration.search': { params: { threadId: ThreadId; query: string }; result: { matches: AgentMatch[]; unavailable: string[] } };
  /** Another contact's conversation, newest `limit` entries (default 30, at most 100) before `before`. */
  'collaboration.read': { params: { threadId: ThreadId; target: AgentAddress; limit?: number; before?: Timestamp }; result: AgentTranscript };
  /**
   * Waits up to `timeoutMs` (at most 300,000) for incoming messages, from `from` only when given,
   * and hands them over as delivered: they are not injected into the turn a second time.
   */
  'collaboration.wait': { params: { threadId: ThreadId; from?: AgentAddress; timeoutMs: number }; result: { letters: AgentLetter[] } };
  'collaboration.identity': { params: Record<string, never>; result: CoordinationPeer };
  'collaboration.peers': { params: Record<string, never>; result: CoordinationPeer[] };
  'collaboration.check': { params: { coreId: string }; result: { ok: true } };
  'collaboration.trust': { params: { peer: CoordinationPeer }; result: CoordinationPeer };
  'collaboration.untrust': { params: { coreId: string }; result: { ok: true } };
  /** Owner-only route over the app's existing authenticated connections. Agents cannot register routes. */
  'collaboration.bridge.register': { params: { coreId: string; enabled: boolean }; result: { ok: true } };
  /** The destination verifies the original core's signature and its local permissions. */
  'collaboration.bridge.forward': { params: { coreId: string; body: string; signature: string }; result: CoordinationBridgeResponse };
  /** Only the owner connection that received this request can complete it. */
  'collaboration.bridge.reply': { params: { requestId: string; response: CoordinationBridgeResponse }; result: { ok: true } };
  'speech.status': { params: Record<string, never>; result: SpeechStatus };
  'speech.configure': { params: SpeechConfig & { groqKey?: string; openrouterKey?: string }; result: SpeechStatus };
  'speech.config': { params: Record<string, never>; result: SpeechConfig };
  /**
   * Downloads a model and activates it once it is complete and checked: `model`
   * names a catalogue entry, `url` an https link to a ggml Whisper file (no digest
   * is known for it, its header is checked instead). Neither means the active
   * model. The runtime comes along when this core needs it.
   */
  'speech.install': { params: { model?: string; url?: string }; result: SpeechStatus };
  'speech.installCancel': { params: Record<string, never>; result: SpeechStatus };
  /** Removes one downloaded model, or with no `model` the runtime and every managed model. */
  'speech.uninstall': { params: { model?: string }; result: SpeechStatus };
  /** A dictation is starting: load the local model now so the first request finds it ready. */
  'speech.warm': { params: Record<string, never>; result: { ok: true } };
  /**
   * PCM WAV, mono 16 kHz. Each connection may have one request in flight. Audio is never journalled.
   * `preview` marks a provisional window, which a local engine may decode faster and less exactly.
   * `language` passes back what a preview of the same recording heard, used when the configured
   * language is automatic, so the final request skips its own detection.
   */
  'speech.transcribe': { params: { requestId: string; revision: string; audio: string; preview?: boolean; language?: string }; result: { text: string; language?: string } };
  'speech.cancel': { params: { requestId: string }; result: { ok: true } };
  'threads.activity.set': { params: { threadId: ThreadId; goal?: { objective: string } | null; loop?: { prompt: string; intervalMs: number; maxIterations?: number | null } | null }; result: ThreadActivity };
  'threads.activity.control': { params: { threadId: ThreadId; kind: 'goal' | 'loop'; action: 'pause' | 'resume' | 'remove' | 'complete' }; result: ThreadActivity };
  'quotas.list': { params: { refresh?: boolean; requestId?: string }; result: AccountQuota[] };
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
   *
   * `nonce` goes with a grant: a random string of 16 to 256 characters the
   * client picks once and repeats on every retry. When the answer carrying the
   * session is lost, the same grant and nonce get the same session back until
   * the grant would have expired or the session first says hello with its
   * token. Without a nonce a grant is strictly one-shot. A nonce of another
   * length, or one sent with a token, is refused with `InvalidParams` naming
   * `nonce`, before the grant is spent.
   */
  hello: {
    params: {
      token?: string;
      grant?: string;
      nonce?: string;
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
   * The agent moves its own thread to another project, named by id, name or
   * folder. A process cannot change folder in the middle of a turn, so while
   * one runs the move waits for it to end (`when: 'turn-end'`), then goes
   * through what `threads.move` does; an idle thread moves on the spot. The
   * agent asked, so its next message carries no `MoveNotice` note: the thread
   * records a system message whose text part has `moved` with `by: 'agent'`.
   * Background work stops at the move. Refused for an unknown project, the
   * thread's own project, and every refusal of `threads.move` that already
   * holds when asked; one that only appears at the end of the turn is a system
   * message saying the move did not happen. A core restart before the turn
   * ends drops a waiting move.
   */
  'agent.move': { params: { threadId: ThreadId; project: string }; result: AgentMove };
  /**
   * The unarchived projects the owner added, the caller's own marked
   * `current`: the names `delegation.spawn` and `agent.move` accept.
   */
  'agent.projects': { params: { threadId: ThreadId }; result: AgentProject[] };
  /**
   * The agent registers an existing folder as a project, as the owner does
   * from the sidebar, so `agent.spawn` and `agent.move` can name it. `path` is
   * absolute; `name` defaults to the folder's name. A folder that is already a
   * project answers it with `added: false` and changes nothing, an archived
   * one included. Refused under the same Communication settings as
   * `agent.spawn` across projects (off, paused, restricted to its own
   * project), for a
   * delegated child or a persistent agent session, and for a thread an agent
   * started until the user has written in it. The caller's timeline gets a
   * system line naming the project.
   */
  'agent.addProject': { params: { threadId: ThreadId; path: string; name?: string }; result: AgentProjectAdded };
  /**
   * The agent starts a new top-level thread in a project the owner added
   * (id, name or absolute folder), on its own provider, account, model,
   * effort and permission mode, and sends `prompt` as the first message,
   * marked `startedBy`. `worktree` puts it on a new branch of its own. The
   * new thread's first answer returns to the caller as an agent message.
   * Refused when the caller's coordination is off or paused, across projects
   * when it is restricted to its own, past an hourly budget (3 in Brief, 12 in
   * Team), for a delegated child or a persistent agent session, and for a
   * thread an agent started until the user has written in it. `requestId`
   * makes a retry return the same thread.
   */
  'agent.spawn': { params: { threadId: ThreadId; project: string; prompt: string; title?: string; worktree?: boolean; requestId: string }; result: AgentSpawn };
  /**
   * Show something in the thread's right panel. Every client subscribed to the
   * thread receives `panel.requested`; `shown` says whether one was. The core
   * checks a path exists inside the working directory and a url is http(s),
   * and refuses by name otherwise.
   */
  'panel.open': { params: { threadId: ThreadId; surface: PanelSurface }; result: { shown: boolean } };
  /** Explicitly publish a bounded file snapshot from this thread's working directory. */
  'artifacts.publish': { params: { threadId: ThreadId; path: string }; result: Message };
  'artifacts.read': { params: { threadId: ThreadId; messageId: MessageId; artifactId: string; renew?: string }; result: ArtifactContent };
  'artifacts.preview': { params: { threadId: ThreadId; path: string }; result: { url: string; shown: boolean } };
  'artifacts.previewClose': { params: { threadId: ThreadId; path: string }; result: { ok: true } };
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
   * Put a project away, or bring it back with `archived: false`. Nothing else
   * changes: its threads keep their state and a running one keeps running.
   * Refused on the drafts project, which a thread with no folder lands in.
   */
  'projects.archive': { params: { projectId: ProjectId; archived?: boolean }; result: Project };
  /** Owner only. Persist a project's default for new drafts and broadcast project.updated. Enabling requires a Git repository. */
  'projects.setWorktreeDefault': { params: { projectId: ProjectId; enabled: boolean }; result: Project };
  /**
   * The image of a project whose `icon.kind` is `image`, as a `data:` URL for
   * an `<img>` (an SVG drawn that way runs no script and loads nothing), at
   * most 256 KB before encoding. Read from the journal, not the folder. Refused
   * with `field: 'projectId'` for a project whose icon is not an image.
   */
  'projects.icon': { params: { projectId: ProjectId }; result: { version: string; dataUrl: string } };
  /**
   * Detects the project's icon again from its folder, stores it and answers
   * the project; `project.updated` follows when the icon changed. Owner only:
   * it reads the disk.
   */
  'projects.refreshIcon': { params: { projectId: ProjectId }; result: Project };
  /**
   * The drafts project: `Boite` in the Documents folder of the machine running
   * this core, or `BOITE_DRAFTS_DIR` when set. The folder and the project are
   * made on the first call and returned as they are on every later one, so a
   * client can ask for it right before its first send.
   */
  'projects.drafts': { params: Record<string, never>; result: Project };
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

  /**
   * The linked worktrees of the project's repository, main checkout and the
   * project's own folder left out, each with what removing it would lose and
   * the thread standing in it. Owner only: it names paths.
   */
  'worktrees.list': { params: { projectId: ProjectId }; result: WorktreeEntry[] };
  /**
   * `git worktree remove`, then `git branch -d` on its branch (`-D` with
   * `force`), then `git worktree prune --expire 1.hour.ago`. Refused by name
   * for a path git does not list for this project, the main checkout, and a
   * worktree a thread that is not archived stands in; refused without `force`
   * when it is dirty or unmerged. A missing directory only loses its
   * registration. `branchDeleted` is false when git kept the branch (not
   * merged, checked out elsewhere) or there was none. Owner only.
   */
  'worktrees.remove': {
    params: { projectId: ProjectId; path: string; force?: boolean };
    result: { ok: true; branchDeleted: boolean };
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
   * Results are kept until refresh, a `providers.reload` that changes a
   * descriptor, or an account whose status or login changes: an unchanged
   * reload or `accounts.check` keeps them.
   * For any other protocol they are the descriptor's models, with `probedAt`
   * the moment of the call.
   */
  'providers.probe': {
    /**
     * `model` also asks for that model's own reasoning efforts. OpenCode names an
     * effort scale per model and only once the session is on it, so the list a
     * plain probe reads carries none; the picker names the model it landed on
     * and the answer comes back with that model's `effort` filled in.
     */
    params: { providerId: ProviderId; accountId: AccountId; refresh?: boolean; model?: string };
    result: { models: ModelInfo[]; probedAt: Timestamp };
  };
  /**
   * Download and unpack the release this profile's `install` block names. On a
   * provider already installed at an older version this is the update: the new
   * release lands beside the old one and `current` is repointed. The old
   * release is deleted once no process of that provider is left, since one may
   * still be running out of it. Refused when the profile carries no such block,
   * when the installed version is already the one the descriptor names, when an
   * install is already running for that provider, or when the free space under
   * the data directory is under the archive, less what a kept `.part` of that
   * same archive already holds, plus the unpacked files plus a 256 MB margin. Progress arrives as `providers.installProgress`.
   */
  'providers.install': { params: { providerId: ProviderId }; result: ProviderInstallState };
  /** Abort the running install. The operation id is the one its state carries. */
  'providers.installCancel': {
    params: { providerId: ProviderId; operationId: string };
    result: ProviderInstallState;
  };
  /** Delete what a managed install put on disk. Refused while a process of that provider is alive. */
  'providers.uninstall': { params: { providerId: ProviderId }; result: ProviderInstallState };
  /**
   * Where every available agent stands against its newest release, on the
   * machine this core runs on. `refresh` asks the agents and the registries
   * again; without it the last reading answers, an empty list when the core
   * has none yet. A plain call never runs an agent.
   */
  'providers.updates': { params: { refresh?: boolean }; result: HarnessUpdate[] };
  /**
   * Bring one agent to its newest release. Refused while a turn of that
   * provider is queued, running or waiting, and when nothing newer is known.
   * The warm processes of the provider are released first, since a running
   * program cannot be replaced. Progress arrives as `providers.updatesChanged`.
   */
  'providers.update': { params: { providerId: ProviderId }; result: HarnessUpdate };
  /** Stop offering this version. A later one is offered again. `version: null` forgets the skip. */
  'providers.updateSkip': { params: { providerId: ProviderId; version: string | null }; result: HarnessUpdate };
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
  'accounts.rename': { params: { accountId: AccountId; label: string }; result: Account };
  /** Refresh the provider's login when requested; never uses a model catalogue as authentication. */
  'accounts.check': { params: { accountId: AccountId; refresh?: boolean }; result: Account };
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
  /**
   * Open a shell with this account's environment and type its login command
   * into it, or attach to the one already open. Only for a login whose
   * descriptor says `terminal`. The default account is allowed: the user drives
   * the shell, as in their own terminal. Closing the terminal rechecks the account.
   */
  'accounts.loginTerminal': { params: { accountId: AccountId; cols: number; rows: number }; result: TerminalState };

  /** Attach to the thread's shell, starting one in the thread's working directory when none runs. */
  'terminals.open': { params: { threadId: ThreadId; cols: number; rows: number }; result: TerminalState };
  /** Keystrokes, as the terminal emulator encodes them. */
  'terminals.write': { params: { id: string; data: string }; result: { ok: true } };
  'terminals.resize': { params: { id: string; cols: number; rows: number }; result: { ok: true } };
  /** Kill the shell and its tree. `terminal.exited` follows. */
  'terminals.close': { params: { id: string }; result: { ok: true } };

  'threads.list': { params: { projectId?: ProjectId; includeArchived?: boolean }; result: ThreadSummary[] };
  /** Read the thread's own branch PR using the execution machine's GitHub CLI. Null when the thread has no branch. */
  /** `refresh`: a user asked, so what the core kept for this repository is read again, and a missing gh is tried again. */
  'threads.pullRequest': { params: { threadId: ThreadId; refresh?: boolean }; result: ThreadSummary['pullRequest'] };
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
       * own: a short temporary `boite/wt-<id>` unless `branch` names one.
       * The title model can name that temporary branch after the first turn;
       * the working directory stays fixed when the branch is renamed. The core
       * runs `git worktree add` and refuses by name when the project is not a
       * git repository, git is missing, or the named branch already exists.
       * Explicit names must fit `BRANCH_NAME_MAX`, including any prefix.
       * Excludes `cwd`. Refused on the drafts project, which is not a repository.
       */
      worktree?: { branch?: string };
    };
    result: ThreadSummary;
  };
  /**
   * The thread with its last `MESSAGE_PAGE` messages and the cursor for what is
   * behind them. Opening a thousand-message thread costs one page, not the lot.
   */
  /**
   * `after` is for a client that already holds the thread, a reconnect or a
   * reopen: the answer then carries that message and the ones written after it
   * rather than the whole page, and says so in `messagesFrom`. The client names
   * the first message it cannot vouch for, the oldest one of a turn it has not
   * seen finish, or its last one. An `after` the thread does not hold, or one
   * with more than a page behind it, is answered with the full page.
   */
  'threads.get': { params: { threadId: ThreadId; after?: MessageId }; result: Thread };
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
   * model `Settings.titleModel` names writes it, else the thread's own agent
   * on its small model when its driver can (Claude and Codex on one short
   * call, echo in memory); the core cuts the first line of the prompt
   * otherwise. Refused by name on a thread that has no prompt yet, or while
   * a title is already being written for it. The answer is the thread as
   * saved, `titleSource` saying which of the two wrote it.
   */
  'threads.retitle': { params: { threadId: ThreadId }; result: ThreadSummary };
  'threads.compact': { params: { threadId: ThreadId; expectedSelectionVersion?: number }; result: Turn };
  /** An ephemeral answer from a snapshot of the chat, without starting or steering its main turn. */
  'threads.btw': { params: { threadId: ThreadId; question: string; requestId: string }; result: { requestId: string } };
  'threads.btw.cancel': { params: { threadId: ThreadId; requestId: string }; result: { ok: true } };
  /** Persist a completed side answer and its frozen context in a fresh conversation. */
  'threads.btw.fork': { params: { threadId: ThreadId; requestId: string }; result: ThreadSummary };
  /**
   * Edit a sent message: `messageId`, a user message of the thread, and every
   * message and turn after it leave the conversation, and the next turn
   * continues from just before it, the agent's own memory included. The answer
   * is the thread as it now stands and the removed message's content, for the
   * composer. Refused while a turn runs or waits in the queue (stop it first),
   * for a message that is not a user message of that thread, and on a
   * persistent agent session, each naming the field and what it expected.
   * Every client subscribed to the thread gets `message.truncated`. The journal
   * keeps the removed messages' events; the removed turns keep their usage.
   */
  'threads.rewind': { params: { threadId: ThreadId; messageId: MessageId }; result: ThreadRewind };
  /**
   * A new thread holding a copy of this thread's history up to and including
   * `messageId`, whose next turn continues from there; the original thread is
   * untouched. `worktree: true` puts it in a git worktree of its own, as
   * `threads.create` does with `worktree: {}`; false or absent works in the
   * same folder. Refused while the named message is still streaming, and on a
   * persistent agent session.
   */
  'threads.fork': { params: { threadId: ThreadId; messageId: MessageId; worktree?: boolean }; result: ThreadSummary };
  /**
   * Move a thread to another project of the same core. Its folder becomes the
   * target's: the project folder, a new git worktree of the target when the
   * thread had a worktree of its own and the target is a repository, or a new
   * draft folder when the target is the drafts project. The old folder or
   * worktree stays on disk untouched. The agent never works in the old folder
   * again: its warm process is dropped, and the next user message tells it the
   * thread moved (`MoveNotice` on that message's text part). Sub-threads follow
   * their parent. A target project put away comes back. Refused for an unknown
   * thread or project, the same project, an archived thread, a sub-thread, a
   * persistent agent session, a missing target folder, a turn running or
   * queued on one of its sub-threads (`reason: 'turn-in-flight'`), and
   * background work without `stopBackground` (true stops it, false leaves it
   * running in the old folder until the agent's next turn). Every client gets
   * `thread.updated` with the new `projectId`, `cwd` and `branch`.
   *
   * A thread whose own turn runs, waits or is queued is not refused: the move
   * is recorded as `pendingMove` on the answered row and happens when that
   * turn ends, however it ends, through the same path as the agent's own move.
   * A second move replaces a pending one; archiving the thread drops it. The
   * pending move lives in memory and a core restart forgets it.
   */
  'threads.move': { params: { threadId: ThreadId; projectId: ProjectId; stopBackground?: boolean }; result: ThreadSummary };
  /**
   * Drop the move waiting for the thread's turn to end (`pendingMove`), the
   * user's or the agent's. Answers the row without it; a thread with no
   * pending move is refused naming `threadId`.
   */
  'threads.moveCancel': { params: { threadId: ThreadId }; result: ThreadSummary };
  /**
   * Put a thread away, or bring it back with `archived: false`. Archiving
   * stops its turn and its sub-threads' turns at once and answers; their
   * processes end once those turns have settled. Restoring restarts nothing.
   */
  'threads.archive': { params: { threadId: ThreadId; archived?: boolean }; result: ThreadSummary };
  /**
   * Hide a conversation and its sub-threads after stopping their work. The
   * owner can restore their history across restarts until the configured
   * retention expires, measured from deletion. Files and Git branches remain.
   */
  'threads.remove': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Owner-only recoverable deleted conversations, newest first. */
  'threads.deleted': { params: Record<string, never>; result: DeletedThreadSummary[] };
  /** Undo deletion without restarting agents; restore each thread's previous archive state. Owner only. */
  'threads.restore': { params: { threadId: ThreadId }; result: ThreadSummary };
  /** Pin or unpin (`pinned: false`) a thread. An archived thread keeps its pin for when it comes back. */
  'threads.pin': { params: { threadId: ThreadId; pinned?: boolean }; result: ThreadSummary };
  'threads.markRead': { params: { threadId: ThreadId }; result: { ok: true } };
  /** Only subscribed threads stream message events to this connection. */
  'threads.subscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  'threads.unsubscribe': { params: { threadId: ThreadId }; result: { ok: true } };
  /** The conversation visible on this connection; null releases its prepared agent. No turn is started. */
  'threads.focus': { params: { threadId: ThreadId | null }; result: { ok: true } };

  /** `attachments` are journalled with the prompt. Files become host paths; images use native provider payloads. */
  'turns.start': { params: { threadId: ThreadId; prompt: string; attachments?: Attachment[]; previewReferences?: PreviewReference[]; expectedSelectionVersion?: number; clientRequestId?: string }; result: Turn };
  /** Sends user input into the active turn; false leaves it queued for a later boundary or turn. */
  'turns.steer': { params: { threadId: ThreadId; turnId: TurnId; prompt: string; attachments?: Attachment[]; previewReferences?: PreviewReference[]; expectedSelectionVersion?: number; clientRequestId: string }; result: { accepted: boolean } };
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
  /** Resolve a pending question without an answer, a steer or a new user message. */
  'questions.skip': {
    params: { threadId: ThreadId; questionId: RequestId };
    result: { ok: true };
  };
  /**
   * An asynchronous question from the agent of a thread (`boite ask`): the card
   * is drawn in the running turn, the agent keeps working, and the answer
   * reaches it later as a steer or as the next prompt. `options` are labels;
   * none makes a free-text question.
   */
  'questions.ask': {
    params: { threadId: ThreadId; text: string; options?: string[]; multiple?: boolean };
    result: { questionId: RequestId };
  };

  'trace.get': { params: { threadId: ThreadId; limit?: number }; result: ProcessRecord[] };
  'resources.list': { params: Record<string, never>; result: ThreadResources[] };
  /** Owner-only machine memory reading and the limits actually applied by the governor. */
  'resources.memoryStatus': { params: Record<string, never>; result: MemoryStatus };
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

  'telemetry.state': { params: Record<string, never>; result: TelemetryState };
  'telemetry.configure': { params: { mode: TelemetryState['mode'] }; result: TelemetryState };
  'telemetry.export': { params: Record<string, never>; result: Record<string, unknown> };
  'telemetry.retryForget': { params: Record<string, never>; result: TelemetryState };
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

export interface RpcEvents extends AgentsRpcEvents, WorkflowsRpcEvents, BrowserRpcEvents {
  'resources.memory': MemoryEvent;
  'thread.memory': MemoryEvent & { threadId: string };
  'delegation.changed': { threadId: ThreadId };
  'collaboration.changed': { threadId: ThreadId };
  /** Sent directly to the owner connection registered for the target core. */
  'collaboration.bridge.request': { requestId: string; fromCoreId: string; toCoreId: string; body: string; signature: string };
  'thread.activity': { threadId: ThreadId; activity: ThreadActivity };
  /** Subscribed threads only: the agent asked for something in the panel. */
  'panel.requested': { threadId: ThreadId; surface: PanelSurface; at: Timestamp };
  /** The project's whole list, after any change. */
  'todos.updated': { projectId: ProjectId; todos: Todo[] };
  'quotas.updated': AccountQuota[];
  /** Owner-only partial result, correlated with the caller's quotas.list request. */
  'quotas.progress': { requestId: string; quota: AccountQuota };
  /** One plugin after any change. A `url` plugin that comes back `not-installed` is gone from the list. */
  'plugins.updated': PluginState;
  /** A project `projects.add` created. A known path returns its project without one. */
  'project.added': Project;
  /** A project `projects.remove` deleted, after the `thread.removed` of each of its threads. */
  'project.removed': { projectId: ProjectId };
  /** A project archived or restored, one whose count of archived threads moved, or one whose icon changed. */
  'project.updated': Project;

  'thread.created': ThreadSummary;
  'thread.updated': ThreadSummary;
  'thread.removed': { threadId: ThreadId; undoable?: boolean };
  /** The owner-only deletion list changed, including purge and removal with a project. */
  'thread.deletionsUpdated': Record<string, never>;
  /** The agent's `/name` commands, whole, each time the list it reports changes. */
  'thread.commands': { threadId: ThreadId; commands: AgentCommand[] };
  /** What the agent still runs in the background, whole, each time it changes. */
  'thread.btw': { threadId: ThreadId; requestId: string; answer: string | null; error: string | null };
  'thread.background': { threadId: ThreadId; tasks: BackgroundTask[] };

  'turn.started': Turn;
  /** A small broadcast lets queued input advance even when its conversation is off screen. */
  'turn.toolCompleted': { threadId: ThreadId; turnId: TurnId; boundary: string };
  'turn.finished': Turn;

  /** Subscribed threads only, from here to `permission.resolved`. */
  'message.started': Message;
  /** Text appended to the part at `partIndex`. */
  'message.delta': { threadId: ThreadId; messageId: MessageId; partIndex: number; text: string };
  /** A part created or replaced whole (tool call state, permission card). */
  'message.part': { threadId: ThreadId; messageId: MessageId; partIndex: number; part: MessagePart };
  'message.completed': { threadId: ThreadId; messageId: MessageId; state: Message['state'] };
  /**
   * `messageId` and every message after it left the thread (`threads.rewind`),
   * and so did their turns. A client holding the thread drops them; one that
   * does not hold `messageId` reads the thread again.
   */
  'message.truncated': { threadId: ThreadId; messageId: MessageId };

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
  /** A hook blocked, failed, stopped a turn or was skipped: `hooks.status` has it. Runs that passed only count. */
  'hooks.changed': { at: Timestamp };
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
  /** The whole list, each time a check, an update or a skip changed one entry. */
  'providers.updatesChanged': HarnessUpdate[];
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
  'core.log': { level: 'info' | 'warn' | 'error'; message: string; at: Timestamp; threadId?: ThreadId };
  'core.updateChanged': ServerUpdateStatus;
  /** What a shell printed, as it printed it. */
  'terminal.output': { id: string; data: string; sequence?: number };
  /** Portable brain switches changed. The folder stays on its host. */
  'brain.configured': BrainConfig;
  /** The shell ended: typed `exit`, closed, or killed with its thread. */
  'terminal.exited': { id: string; exitCode: number | null };
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

/**
 * The `data` of the Refused error `turns.start` answers while the thread
 * already has a turn queued or running, often one the core opened by itself
 * (held answers to asynchronous questions, an agent resuming on its own). The
 * prompt is not wrong, only early: `thread` is the row as the core has it, and
 * a client keeps the prompt until that turn is over.
 */
export interface TurnInFlightData {
  threadId: ThreadId;
  reason: 'turn-in-flight';
  thread: ThreadSummary;
}

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
export { AUTO_COMPACT_MOMENTS, AUTO_COMPACT_TOKENS, BROWSER_ORIGINS_MAX, checkSettingsPatch, type AutoCompact, type AutoCompactMoment, type SettingsPatchCheck } from './settings-validation.ts';
import type { AutoCompact } from './settings-validation.ts';
export { TITLE_MODEL_DEFAULTS, defaultTitleModel } from './title-models.ts';
export { DEVICE_METHODS, DEVICE_EVENTS, AGENT_EVENTS } from './access.ts';
export { SPEECH_CATALOGUE, SPEECH_CUSTOM_ID, SPEECH_DEFAULT_MODEL, isSpeechModelId, speechUrlProblem, type SpeechCatalogueModel, type SpeechModelTier } from './speech-models.ts';
import type { SpeechModelTier } from './speech-models.ts';

/** Protocols that can answer a side question with tools disabled. */
export function supportsSideQuestions(protocol: Protocol): boolean {
  return protocol === 'claude-sdk' || protocol === 'echo';
}

export { sideQuestionSnapshot } from './side-question-snapshot.ts';
