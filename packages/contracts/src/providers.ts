import type { AccountId, ProviderId, ThreadId, Timestamp } from './ids';

// ---------------------------------------------------------------------------
// Providers: one JSON descriptor per provider, shipped or user-supplied.
// ---------------------------------------------------------------------------

/** How the core talks to an agent. */
export type Protocol = 'claude-sdk' | 'codex-appserver' | 'muse' | 'pi' | 'acp' | 'echo';

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
  /**
   * Taken only when the program found there reports this major version. Two
   * majors of one agent can install under one name (`opencode` is OpenCode 1
   * or OpenCode 2), and each has its own descriptor: without this the first
   * descriptor would start the other one's program. The version is read once
   * per program file with the profile's `update.versionArgs`, default
   * `--version`, and until that reading is in the candidate does not resolve.
   */
  major?: number;
}

/**
 * A release Boite downloads and unpacks itself, for an agent whose binary is
 * not on the machine and has no installer of its own. The files land under
 * `{agentsDir}`, which is what the profile's executable candidate names.
 */
export interface ProviderInstall {
  /** A version string shown to the user and written beside the files. */
  version: string;
  /**
   * Omitted for zip archives; binary downloads contain exactly one file; `tgz`
   * is a gzipped tar, the shape of an npm package tarball.
   */
  format?: 'zip' | 'binary' | 'tgz';
  /** The archive or executable download. */
  url: string;
  sha256: string;
  archiveBytes: number;
  /** Omit for architecture-independent archives. */
  arch?: 'x64' | 'arm64';
  /** Files expected inside the archive, relative paths inside it, with their sizes; the first one is the executable. */
  files: { path: string; bytes: number; executable?: boolean }[];
  /**
   * Where the newest release is published, for a `binary` install. The core
   * reads it before an install, at each update check, and behind a provider
   * list when the last read is an hour old so the install card names it. It
   * installs that release instead of the pinned one, which stays the fallback
   * when the publisher was never reached.
   */
  latest?: ProviderInstallLatest;
}

/**
 * A publisher that names its newest release in a plain-text file and describes
 * each release in a JSON manifest carrying, per platform, the binary's name,
 * SHA-256 and size. Claude's release bucket has this shape. `manifest` and
 * `url` contain `{version}`.
 */
export interface ProviderInstallLatest {
  /** A plain-text file holding the newest version. */
  versionUrl: string;
  /** That version's manifest. */
  manifest: string;
  /** The key under the manifest's `platforms`, such as `win32-x64`. */
  platform: string;
  /** That version's binary. */
  url: string;
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
  /**
   * While `updating`: the running turns of this agent that have not paused
   * between two tool calls yet. The updater starts once none is left
   * unpaused, and they resume once it is done. Absent or zero once the updater runs.
   */
  waitingFor?: number;
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
  /**
   * A SQLite database inside the isolation directory that carries the login,
   * for an agent that keeps its credentials in one: the account reads `ok`
   * once any of these tables holds a row, and `unauthenticated` while none
   * does or the file is not there yet. Read without a lock, never written.
   * OpenCode 2 stores every sign-in in the `credential` table of `opencode.db`.
   */
  sqlite?: { file: string; tables: string[] };
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
 * Top-level keys of a JSON file an isolated account keeps as its own, set from
 * the user's copy of that file before every spawn. The agent writes the rest of
 * the file itself (its sign-in identity, per-project state), so the file is
 * never copied whole. Claude keeps its user-scope MCP servers this way, under
 * `mcpServers` in `.claude.json`.
 */
export interface ProviderSharedKeys {
  /** An isolation variable of the profile; the account's file is `path` under the account's value of it. */
  variable: string;
  /** Relative to the variable's directory, no `..`. */
  path: string;
  /**
   * The user's file when the variable is not set, starting with `~/`, for an
   * agent that keeps it elsewhere than `path` under the variable's default:
   * Claude reads `~/.claude.json`, not `~/.claude/.claude.json`.
   */
  home?: string;
  /** Top-level keys, each replaced whole. */
  keys: string[];
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
export type ProviderQuirk = 'antigravity' | 'grok' | 'hermes';

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
  /**
   * Reasoning effort this model offers. A model without it has no effort control.
   * `default` is the level the agent runs this model on when none is picked;
   * absent when the agent decides it itself and the core cannot read it (pi
   * knows only the level of the model its session is on), so a thread on that
   * model sends no level until the user picks one.
   */
  effort?: { levels: EffortLevel[]; default?: string };
  /** Native service tiers advertised for this model; absent means no speed control. */
  speeds?: SpeedTier[];
}
/** One native service tier of a model, such as Claude's `fast` or the Codex tier `priority` labelled "Fast". */
export interface SpeedTier {
  id: string;
  label: string;
  description?: string;
}

export interface ProviderCapabilities {
  approvals: boolean;
  hooks: boolean;
  checkpoint: boolean;
  images: boolean;
  planMode: boolean;
  resume: boolean;
}

/** Stable reasons for an unavailable thread control; clients localize these codes. */
export type ThreadCapabilityReason = 'unsupported' | 'provider-unavailable' | 'provider-disabled' | 'account-unavailable' | 'archived' | 'agent-session' | 'busy' | 'not-running' | 'no-session' | 'no-command' | 'no-checkpoint' | 'selection-changed' | 'awaiting-input' | 'no-request' | 'no-history' | 'stopping' | 'updating' | 'plugins-blocked';
export interface ThreadCapability {
  supported: boolean;
  available: boolean;
  reason: ThreadCapabilityReason | null;
}
/** Point-in-time runtime facts. Native history availability means at least one eligible
 * boundary exists; fork/rewind still validate the requested message and worktree. */
export interface ThreadCapabilities {
  threadId: ThreadId;
  providerId: ProviderId;
  protocol: Protocol | null;
  selectionVersion: number;
  steering: ThreadCapability;
  compaction: ThreadCapability;
  images: ThreadCapability;
  plan: ThreadCapability;
  approvals: ThreadCapability;
  questions: ThreadCapability;
  fork: { native: ThreadCapability; seeded: ThreadCapability };
  rewind: { native: ThreadCapability; seeded: ThreadCapability };
  sessionPreparation: ThreadCapability;
  backgroundObservations: ThreadCapability;
}

export interface ProviderDescriptor {
  id: ProviderId;
  schemaVersion: 1;
  name: string;
  shortName: string;
  protocol: Protocol;
  /** Every path the engine reads or writes for this provider must fall under one of these. */
  roots: string[];
  /** Defaults merged into every OS profile's env at load time; the profile wins. */
  env?: Record<string, string>;
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
  /** Keys of a JSON file the account keeps as its own, taken from the user's copy of that file. */
  sharedKeys?: ProviderSharedKeys[];
  /** Where the user's own hooks live. Only with `capabilities.hooks`. */
  hookSources?: ProviderHookSource[];
  /** Dialect fixes the driver of this protocol applies for this agent only. */
  quirks?: ProviderQuirk[];
  /**
   * An agent Boite drives without long use behind it. It stays off until the
   * user turns it on in Providers, and its row says so.
   */
  experimental?: boolean;
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
  /**
   * False when the provider is turned off: the user's own choice
   * (`providers.setEnabled`), or an experimental provider nobody turned on yet.
   * An off provider starts nothing: no turn, probe, version check or usage
   * read, and no picker offers it. Its accounts and threads are kept. Missing
   * on older cores, which read as on; read it through `providerEnabled`.
   */
  enabled?: boolean;
  /** The descriptor's `experimental`. Missing reads as false. */
  experimental?: boolean;
}

/** Whether a provider is turned on. A summary from a core older than the switch has no field and is on. */
export function providerEnabled(summary: Pick<ProviderSummary, 'enabled'> | null | undefined): boolean {
  return summary !== null && summary !== undefined && summary.enabled !== false;
}

/**
 * An ACP agent described by the command that starts it: the program, by name
 * on PATH or by absolute path, its arguments one per entry, taken literally,
 * and the environment variables it adds. `name` is what the picker shows.
 */
export interface LocalAcpCommand {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** A descriptor that did not load. Always shown, never silent. */
export interface ProviderRejected {
  file: string;
  field: string;
  expected: string;
  message: string;
}

/** Protocols that can answer a side question with tools disabled. */
export function supportsSideQuestions(protocol: Protocol): boolean {
  return protocol === 'claude-sdk' || protocol === 'echo';
}

export interface ProvidersRpcMethods {

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
   * reload or `accounts.check` keeps them. An account with no list read since
   * then gets the one saved under the same descriptor, executable, gateway and
   * login at once, and the fresh read arrives as `providers.probed`.
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
   * Bring one agent to its newest release. Refused when nothing newer is
   * known. A running turn of that provider is paused once its tool calls are
   * done, and resumes in the same turn after the update; turns queued while
   * the updater runs start after it. The warm processes of the provider are
   * released first, since a running program cannot be replaced. Progress
   * arrives as `providers.updatesChanged`.
   */
  'providers.update': { params: { providerId: ProviderId }; result: HarnessUpdate };
  /** Stop offering this version. A later one is offered again. `version: null` forgets the skip. */
  'providers.updateSkip': { params: { providerId: ProviderId; version: string | null }; result: HarnessUpdate };
  /**
   * Turn one provider on or off on this core's machine. Off, nothing of that
   * provider starts and no picker offers it; its accounts, its threads and its
   * install stay as they are, and a turn already queued or running ends by itself. On
   * again, its default account is adopted if an existing login is found. The
   * answer and `providers.updated` carry every summary with its `enabled`.
   * Owner only: it decides what the machine runs.
   */
  'providers.setEnabled': {
    params: { providerId: ProviderId; enabled: boolean };
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  /**
   * Write a user descriptor for an ACP agent from a command: `protocol: "acp"`,
   * one profile for this machine's OS, `args` passed one by one with no shell,
   * `env` added to the agent's environment. The agent keeps its own login and
   * configuration, and its models come from its ACP answers. The id is the
   * name's `localAcpId`; refused with the field when `checkLocalAcpCommand`
   * refuses, when another provider or file already has that id, or when the
   * program cannot be found on this machine. The answer and `providers.updated`
   * carry the new list. Owner only: it decides what the machine runs.
   */
  'providers.addLocal': {
    params: LocalAcpCommand;
    result: { providerId: ProviderId; loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  /**
   * Delete a user descriptor, whether `providers.addLocal` or a hand wrote it.
   * Refused for a shipped provider and while a turn of that provider is queued
   * or running; its warm processes are released first. Its accounts and threads
   * stay, and come back when a descriptor with the same id loads again.
   */
  'providers.removeLocal': {
    params: { providerId: ProviderId };
    result: { loaded: ProviderSummary[]; rejected: ProviderRejected[] };
  };
  /** Validate a user descriptor and show what it would do. Writes nothing. */
  'providers.dryRun': {
    params: { file: string };
    result:
      | { ok: true; summary: ProviderSummary; plan: { roots: string[]; env: string[]; closes: string[] } }
      | { ok: false; rejected: ProviderRejected };
  };
}

export interface ProvidersRpcEvents {
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
}
