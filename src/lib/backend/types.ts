// The single contract every workspace transport implements. TauriBackend
// drives the local desktop via invoke; RemoteBackend (later) drives a
// boite-server over a WebSocket. Façades under storage/ and features/*/api.ts
// keep their public signatures and delegate here, so swapping the transport
// never touches a component or store.

import type {
  Project,
  Settings,
  Thread,
  TodoItem,
} from "$lib/types";
import type {
  BranchChangeResult,
  BranchInfo,
  ChangeEntry,
  Commit,
  CommitState,
  PrLookup,
  RepoInfo,
} from "$lib/features/git/api";
import type {
  ChangedPath,
  DirEntry,
  SearchHit,
} from "$lib/features/explorer/api";
import type { FileVersions, TextFile } from "$lib/features/editor/api";
import type { ShellOption } from "$lib/storage/platform.svelte";
import type { LogEntry, LogLevel } from "$lib/shared/services/logger.svelte";

// Output arrives as raw bytes regardless of transport. The Tauri channel
// carries base64 (decoded inside TauriBackend); the remote socket carries
// binary frames. Components see bytes either way.
export type PtyEvent =
  | { type: "output"; bytes: Uint8Array }
  // Server told the client to clear before the replay that follows (the delta
  // it asked for had rolled out of the ring, so a full repaint is coming).
  | { type: "reset" }
  | { type: "title"; value: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface WrapSpec {
  shellId: string;
  noProfile: boolean;
}

export interface PtySpawnArgs {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
  // Shell the command may need to go through for its functions and aliases to
  // exist. Offered, not imposed: the runner keeps it only when the command is
  // not something it can spawn on its own.
  wrap?: WrapSpec;
}

export interface PtyOpenArgs {
  threadId: string;
  spec: PtySpawnArgs;
  meta: { projectId: string; label: string; iconKey: string | null };
}

export interface PtyApi {
  // Attach-or-spawn for a thread. Returns the live key (local ptyId / remote
  // server pty id) that the caller stores as thread.ptyId; write/resize/kill
  // take that key. Local always spawns (no detached PTYs yet); remote attaches
  // to a live thread or spawns then attaches.
  open(args: PtyOpenArgs, onEvent: (event: PtyEvent) => void): Promise<string>;
  write(key: string, data: Uint8Array): Promise<void>;
  resize(key: string, cols: number, rows: number): Promise<void>;
  kill(key: string, wait?: boolean): Promise<void>;
  // Detach this client without terminating. Local has no detached PTYs yet so
  // it kills; remote detaches and the server keeps the process running.
  release(key: string): Promise<void>;
}

export interface DbApi {
  loadProjects(): Promise<Project[]>;
  saveProject(project: Project): Promise<void>;
  setProjectArchived(id: string, archived: boolean): Promise<void>;
  deleteProject(id: string): Promise<void>;
  loadThreads(): Promise<Thread[]>;
  saveThread(thread: Thread): Promise<void>;
  updateThreadTitle(id: string, title: string | null): Promise<void>;
  deleteThread(id: string): Promise<void>;
  loadSettings(): Promise<Partial<Settings>>;
  saveSettings(settings: Settings): Promise<void>;
  loadTodos(): Promise<TodoItem[]>;
  /**
   * Writes one row. Todos are the only table an outside process also writes
   * (the MCP endpoint), so they are never persisted as a whole-list blob: two
   * writers against one blob lose each other's edits.
   */
  saveTodo(todo: TodoItem): Promise<void>;
  deleteTodo(id: string): Promise<void>;
}

export interface GitApi {
  repoInfo(path: string): Promise<RepoInfo>;
  findRepos(path: string): Promise<string[]>;
  branches(path: string): Promise<BranchInfo[]>;
  switchBranch(path: string, name: string, create: boolean, stash: boolean): Promise<BranchChangeResult>;
  status(path: string): Promise<ChangeEntry[]>;
  log(path: string, limit: number, skip: number): Promise<Commit[]>;
  /**
   * What the repository says about a sha an agent reported: whether it exists
   * at all, and whether it has left this machine. An unknown sha comes back
   * with `known: false` rather than as an error — being unable to find it is
   * the answer, not a failure to get one.
   */
  commitState(path: string, sha: string): Promise<CommitState>;
  /**
   * What `gh` says about a branch. Not an option: a `gh` that is there and
   * refusing is worth telling the user about, and a missing one is not.
   */
  pullRequest(path: string, branch: string): Promise<PrLookup>;
  stage(path: string, files: string[]): Promise<void>;
  unstage(path: string, files: string[]): Promise<void>;
  discard(path: string, files: string[], untracked: string[]): Promise<void>;
  commit(path: string, message: string): Promise<string>;
  fetch(path: string): Promise<void>;
  push(path: string): Promise<void>;
  pull(path: string): Promise<void>;
  init(path: string): Promise<void>;
}

/**
 * One worktree of a repository, as the repository itself describes it.
 *
 * Read from git rather than from Boite's threads on purpose: a worktree whose
 * thread was deleted is still on disk, still holding whatever was in it, and is
 * exactly the one no panel can show today.
 */
export interface WorktreeEntry {
  path: string;
  /** Null when HEAD is detached, which is how Boite opens every worktree. */
  branch: string | null;
  head: string;
  /** The repository's own checkout. Never offered for removal. */
  main: boolean;
  locked: boolean;
  /** Its directory is gone; only git's administrative file is left. */
  prunable: boolean;
  dirty: boolean;
  orphanCommits: boolean;
}

/** What a worktree still holds that removing it would destroy. */
export interface WorktreeHold {
  /** Modified, staged or untracked files. */
  dirty: boolean;
  /** HEAD is on no local branch, so these commits exist nowhere else. */
  orphanCommits: boolean;
}

export interface WorktreeApi {
  /**
   * Opens a detached worktree for a thread and returns its directory, or null
   * when this repository is not one to open a worktree in — not a repo, or a
   * dirty checkout whose in-flight work the thread has to see. The caller does
   * not choose the path: it is derived from the thread id under the machine's
   * own worktree base, which is the only one in scope.
   *
   * The eligibility check belongs to this call rather than to the caller: on
   * Windows every extra round trip costs a `git` process spawn, and those are
   * what a new thread waits on.
   */
  open(repo: string, threadId: string): Promise<string | null>;
  /**
   * Every worktree of a repository, the main checkout included, each with what
   * removing it would destroy. One call rather than a list plus a `hold` per
   * entry: each flag costs a git process, and on Windows those round trips are
   * the whole cost of drawing the page.
   */
  list(repo: string): Promise<WorktreeEntry[]>;
  /**
   * Puts a branch on a detached worktree, once its work has proved worth
   * keeping. Rejects a name that is already taken.
   */
  claim(path: string, name: string): Promise<void>;
  /**
   * Moves the worktree onto a branch that already exists — continuing
   * something started earlier rather than naming something new. Rejects a
   * branch another worktree holds, naming which one.
   */
  reserve(path: string, name: string): Promise<void>;
  hold(path: string): Promise<WorktreeHold>;
  /**
   * Removes a worktree. Without `force` this refuses while it still holds
   * work, which is what makes automatic cleanup safe.
   */
  remove(repo: string, path: string, force: boolean): Promise<void>;
}

export interface ExplorerApi {
  readDir(path: string): Promise<DirEntry[]>;
  changedPaths(path: string): Promise<ChangedPath[]>;
  search(path: string, query: string, limit: number): Promise<SearchHit[]>;
}

export interface EditorApi {
  readTextFile(path: string): Promise<TextFile>;
  writeTextFile(path: string, content: string): Promise<number>;
  fileVersions(
    path: string,
    file: string,
    headFile: string | null,
  ): Promise<FileVersions>;
}

/** What is already sitting where a new project wants to go. */
export type FolderState = "missing" | "empty" | "occupied";

export interface ProjectApi {
  inspect(
    path: string,
  ): Promise<{ name: string; icon: string | null; tech?: string | null }>;
  /**
   * The user's home folder on the machine that runs the threads. Where a thread
   * with no project of its own runs, and the fallback parent for a project
   * created without a path.
   */
  homeDir(): Promise<string>;
  folderState(path: string): Promise<FolderState>;
  /**
   * Makes the folder a new project will live in, and refuses anywhere it has no
   * business being: a project goes under the home folder or beside one that
   * already exists. An agent can ask for this through the MCP endpoint, so the
   * limit is enforced where the folder is made, not where it is requested.
   */
  createFolder(path: string): Promise<void>;
}

export interface ShellApi {
  defaultShell(): Promise<string>;
  availableShells(): Promise<ShellOption[]>;
  // Whether a command resolves on the machine that would run it. Asked by the
  // setup wizard; for a remote boite the answer has to come from the server,
  // since that is where the agents live.
  commandExists(cmd: string): Promise<boolean>;
  // Asks the runner to list what this shell defines itself, ahead of the first
  // spawn that needs the answer. Fire and forget: it returns before the probe
  // finishes, and a spawn that beats it just falls back to the PATH.
  warmShell(shellId: string): Promise<void>;
}

/**
 * What `fastpick --list --json` answers. Only the fields boite reads are typed: the
 * document is fastpick's, it carries a `schema` number, and a field it grows is not a
 * reason to touch this file.
 */
export interface FastpickListing {
  schema: number;
  harnesses: FastpickHarness[];
  providers: FastpickProvider[];
  /** Only present when a provider was asked for. */
  models?: FastpickModels;
}

export interface FastpickHarness {
  id: string;
  name: string;
  /**
   * Which agent this is, whatever the config named it. `id` is the user's word and can be
   * anything, so the icon and the session machinery key off this instead.
   */
  kind: "claude-code" | "opencode" | "codex";
  /** Whether the agent's binary is on the machine that would run it. */
  installed: boolean;
  supportsEffort: boolean;
  supportsSystemPrompts: boolean;
  /** Providers wired to this harness. A pair absent here cannot be launched. */
  providers: string[];
}

export interface FastpickProvider {
  id: string;
  name: string;
  /** Heading several providers share, typically the site they belong to. */
  group: string | null;
  needsKey: boolean;
  /**
   * Whether that key file is there. fastpick never reports where it is or what is in it,
   * and boite never asks: the credential is read at spawn time, on the machine that spawns.
   */
  keyPresent: boolean;
  /** What each wired harness reaches this provider through, keyed by harness id. */
  harnesses?: Record<string, FastpickBinding>;
  /** Set when fastpick has to start a local proxy first. */
  proxyPort?: number | null;
}

export interface FastpickBinding {
  /**
   * Null means the harness keeps its own endpoint, which is how a native provider is
   * declared. That is the one case where the agent runs exactly as it would have without
   * fastpick, and it is what tells a stock Claude apart from a Claude pointed elsewhere.
   */
  baseUrl?: string | null;
}

export interface FastpickModels {
  provider: string;
  /** Where the list came from, so a cached one is never shown as live. */
  source: { kind: "live" | "cache" | "config" | "failed"; ageSecs?: number; error?: string };
  items: FastpickModel[];
}

export interface FastpickModel {
  id: string;
  label: string | null;
  contextWindow: number | null;
  effort: string[];
  effortDefault: string | null;
  /** System prompt files matching this model, most specific first, as `--md` names. */
  prompts: string[];
}

export interface FastpickApi {
  /**
   * The harnesses, providers and bindings fastpick declares. With `provider`, that
   * provider's models too — a separate call because each one costs an HTTP request, and
   * fastpick answers from its cache unless `refresh` is set.
   *
   * Rejects when fastpick is missing or its config is unusable, carrying fastpick's own
   * message. Ask `shell.commandExists("fastpick")` first to tell the two apart.
   */
  list(provider?: string, refresh?: boolean): Promise<FastpickListing>;
  /**
   * What fastpick reports for `--version` on that machine, or null when there is none to
   * ask. Never rejects: absence is one of the two answers the settings panel wants.
   */
  version(): Promise<string | null>;
}

export interface ScopeApi {
  registerProjectRoots(roots: string[]): Promise<void>;
  // The server's browsable base dir for adding projects via the web folder
  // picker. Null on desktop (native dialog) and on servers with no
  // BOITE_WORKSPACE_DIR set.
  workspaceRoot(): Promise<string | null>;
}

export type SessionKind =
  | "claude"
  | "codex"
  | "opencode"
  | "cursor"
  | "antigravity"
  | "copilot"
  | "grok"
  | "hermes";

export interface SessionHit {
  id: string;
  mtimeMs: number | null;
  // First user prompt, for CLIs that never emit a descriptive OSC title
  // (codex). Used to name the thread when it has no title yet.
  title?: string | null;
}

/** A session claude has open, and what can be done about it. */
export interface LiveClaudeSession {
  id: string;
  /** `bg` is reachable through the agent view; `interactive` belongs to another terminal. */
  kind: string;
  /**
   * `busy` while a turn is in flight, `idle` otherwise.
   *
   * Subagents get no entry of their own (the Task tool runs them in the parent
   * process), so the parent reads `busy` for as long as one is working. That is
   * the only signal Boite has that survives a terminal going quiet for minutes.
   */
  status: string;
  /**
   * The directory the session runs in, as claude recorded it. Lets a caller place
   * a session whose id it has not captured yet.
   */
  cwd: string;
}

/**
 * One model's share of what was spent, as its own store recorded it.
 *
 * Cache reads are kept apart from input rather than folded in: on a long agent
 * session they are most of the volume and none of the price, and one "input"
 * number would read as twenty times the work that was actually done.
 */
export interface ModelUsage {
  /** Icon key of the agent that spent it — `claude` or `codex`. */
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

/** A day something was spent on, UTC. Empty days are not sent. */
export interface DayUsage {
  day: string;
  total: number;
}

export interface UsageReport {
  /** Heaviest first. */
  models: ModelUsage[];
  /** Ascending by day. */
  days: DayUsage[];
  sessions: number;
  /** Agents whose store is not on this machine at all, by icon key. */
  missing: string[];
}

export interface SessionApi {
  /**
   * What the agents spent in these directories over the last `days`.
   *
   * The caller passes the directories rather than a project id: since worktree
   * isolation a project's threads mostly run outside its folder, and every
   * store keys on the directory the agent ran in.
   *
   * Only claude and codex answer. The other CLIs keep no per-turn accounting
   * this can read, and an invented number is worse than an absent one.
   */
  usage(cwds: string[], days: number): Promise<UsageReport>;
  /**
   * `ptyId` names the PTY asking. Its process holds the session the caller is
   * trying to bind, and that one alone is exempt from the liveness filter —
   * without it, an agent is unbindable for exactly as long as it runs.
   * Omitted (a caller with no PTY of its own), every live session is skipped.
   */
  find(
    kind: SessionKind,
    cwd: string,
    afterUnixMs: number,
    excludeIds: string[],
    ptyId?: string | null,
  ): Promise<SessionHit | null>;
  /**
   * Session ids claude currently has open, of any kind. `--resume` refuses
   * every one of them, so a captured id has to be checked before it is
   * replayed. Backends that cannot answer return an empty list, which reads as
   * "nothing is live" and preserves the old behaviour.
   */
  liveClaude(): Promise<LiveClaudeSession[]>;
  /**
   * Releases a background agent holding a session, so `--resume` works on it
   * again. Only ever stops a background agent — an interactive session is
   * another terminal's, and taking it down is not ours to do. Returns whether
   * anything was stopped.
   */
  stopClaude(sessionId: string): Promise<boolean>;
  /**
   * Whether copilot would take this session back. Sessions it opened but never
   * used are refused by id, and threads captured before that was known still
   * carry one. Backends that cannot answer say `true`, which replays the id as
   * before rather than dropping a conversation on a guess.
   */
  copilotResumable(sessionId: string): Promise<boolean>;
  /**
   * Carries a transcript to the folder a thread is moving to, and answers
   * whether the conversation can be resumed from there.
   *
   * Claude files its sessions under the directory they ran in, so a thread that
   * changes project changes where `--resume` looks and the conversation drops
   * out of reach. The other CLIs key their stores by time or by an internal
   * database, and answer `true` without anything being carried.
   *
   * `false` means replaying the id over there would fail — the caller drops the
   * session and lets the thread start a fresh conversation, rather than
   * launching with a `--resume` nothing backs.
   */
  migrate(
    kind: SessionKind,
    sessionId: string,
    fromCwd: string,
    toCwd: string,
  ): Promise<boolean>;
}

export interface LogApi {
  event(
    level: LogLevel,
    source: string,
    message: string,
    details: string | null,
  ): Promise<void>;
  read(scope: "current" | "previous"): Promise<LogEntry[]>;
  clear(): Promise<void>;
  filePath(): Promise<string>;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

// Web Push, remote-only. The desktop uses native OS notifications, so
// TauriBackend omits this entirely. publicKey returns the server's VAPID key
// (applicationServerKey) the browser needs to subscribe.
export interface PushApi {
  publicKey(): Promise<string | null>;
  subscribe(sub: PushSubscriptionJson): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
}

// Local derives thread status client-side (statusEngine + OSC/output sniffing)
// and is authoritative. Remote treats the server as authoritative: status and
// title arrive as control events; the client only projects them.
export interface BackendCaps {
  clientStatus: boolean;
}

// Server-pushed control plane (remote only). Loosely typed so the store can
// switch on event name without the backend needing to know every consumer.
export interface ControlEvent {
  event: string;
  data: unknown;
}

// Cosmetic, server-synced workspace identity. A connected device can rename or
// recolor the boite; the server persists it and broadcasts a workspace.info
// control event so every other connected device updates live. Remote-only.
export interface WorkspaceMeta {
  name: string | null;
  color: string | null;
}

export interface WorkspaceMetaApi {
  get(): Promise<WorkspaceMeta>;
  set(patch: Partial<WorkspaceMeta>): Promise<WorkspaceMeta>;
}

export interface Backend {
  readonly kind: "tauri" | "remote";
  readonly caps: BackendCaps;
  // Subscribe to server-pushed control events (remote only). Returns an
  // unsubscribe fn. Absent on local, where there is no control plane.
  subscribe?(cb: (event: ControlEvent) => void): () => void;
  readonly pty: PtyApi;
  readonly db: DbApi;
  readonly git: GitApi;
  readonly worktree: WorktreeApi;
  readonly explorer: ExplorerApi;
  readonly editor: EditorApi;
  readonly project: ProjectApi;
  readonly shell: ShellApi;
  readonly fastpick: FastpickApi;
  readonly scope: ScopeApi;
  readonly session: SessionApi;
  readonly log: LogApi;
  // Web Push registration. Present only on remote (web/PWA); undefined on
  // desktop, which notifies through the OS directly.
  readonly push?: PushApi;
  // Cosmetic workspace identity (name/color). Remote only; the local desktop
  // workspace is always labeled "Local".
  readonly meta?: WorkspaceMetaApi;
  /**
   * Whether this device is the one to carry out an agent request.
   *
   * True exactly once per id, across every device connected to the boite. The
   * request itself is broadcast because the server cannot tell which device is
   * watching — but a move run twice kills one PTY twice and leaves a second
   * worktree behind, so acting on one is a claim, not a notification.
   *
   * Remote only: the desktop delivers these as a Tauri event to the one app
   * that could have received them.
   */
  claimAgentRequest?(requestId: string): Promise<boolean>;
}
