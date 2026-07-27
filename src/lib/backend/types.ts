// The single contract every workspace transport implements. TauriBackend
// drives the local desktop via invoke; RemoteBackend (later) drives a
// boite-server over a WebSocket. Façades under storage/ and features/*/api.ts
// keep their public signatures and delegate here, so swapping the transport
// never touches a component or store.

import type { Project, Settings, Thread, TodoItem } from "$lib/types";
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

export interface ProjectApi {
  inspect(
    path: string,
  ): Promise<{ name: string; icon: string | null; tech?: string | null }>;
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
  /** `busy` while a turn is in flight, `idle` otherwise. */
  status: string;
}

export interface SessionApi {
  find(
    kind: SessionKind,
    cwd: string,
    afterUnixMs: number,
    excludeIds: string[],
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
  readonly explorer: ExplorerApi;
  readonly editor: EditorApi;
  readonly project: ProjectApi;
  readonly shell: ShellApi;
  readonly scope: ScopeApi;
  readonly session: SessionApi;
  readonly log: LogApi;
  // Web Push registration. Present only on remote (web/PWA); undefined on
  // desktop, which notifies through the OS directly.
  readonly push?: PushApi;
  // Cosmetic workspace identity (name/color). Remote only; the local desktop
  // workspace is always labeled "Local".
  readonly meta?: WorkspaceMetaApi;
}
