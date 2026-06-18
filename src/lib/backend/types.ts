// The single contract every workspace transport implements. TauriBackend
// drives the local desktop via invoke; RemoteBackend (later) drives a
// boite-server over a WebSocket. Façades under storage/ and features/*/api.ts
// keep their public signatures and delegate here, so swapping the transport
// never touches a component or store.

import type { Project, Settings, Thread } from "$lib/types";
import type { ChangeEntry, Commit, RepoInfo } from "$lib/features/git/api";
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
  | { type: "title"; value: string }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

export interface PtySpawnArgs {
  cwd: string;
  cmd: string;
  args: string[];
  cols: number;
  rows: number;
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
}

export interface GitApi {
  repoInfo(path: string): Promise<RepoInfo>;
  status(path: string): Promise<ChangeEntry[]>;
  log(path: string, limit: number, skip: number): Promise<Commit[]>;
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
  inspect(path: string): Promise<{ name: string; icon: string | null }>;
}

export interface ShellApi {
  defaultShell(): Promise<string>;
  availableShells(): Promise<ShellOption[]>;
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
  | "copilot";

export interface SessionHit {
  id: string;
  mtimeMs: number | null;
}

export interface SessionApi {
  find(
    kind: SessionKind,
    cwd: string,
    afterUnixMs: number,
    excludeIds: string[],
  ): Promise<SessionHit | null>;
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
