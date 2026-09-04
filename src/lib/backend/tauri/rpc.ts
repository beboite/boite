import { invoke } from "./ipc";
import { log } from "$lib/shared/log";
import type { PilotApi } from "../types";
import type {
  PilotCatalog,
  PilotEvent,
  PilotEventRow,
  PilotItemRow,
  PilotOpened,
  PilotSwitchKind,
} from "$lib/features/pilot/types";
import type {
  ApprovalsApi,
  LogsApi,
  LogRecord,
  SyncApi,
  TelemetryApi,
  TelemetryState,
  SyncConflict,
  SyncJob,
  SyncProbe,
  SyncSource,
  SyncStatus,
  PendingApproval,
  Checkpoint,
  CheckpointApi,
  CheckpointDiff,
  CheckpointFileVersions,
  EditorApi,
  ExplorerApi,
  CodexSwitcherApi,
  CliApi,
  CliDataPath,
  CliLatest,
  CliJob,
  CliRow,
  McpApi,
  McpServerRow,
  FastMcpSshApi,
  KebaccSwitcherApi,
  KebaccSwitcherList,
  CodexSwitcherList,
  FastpickApi,
  FastpickListing,
  FolderState,
  GitApi,
  LiveClaudeSession,
  AgentTurn,
  UsageReport,
  LogApi,
  ProjectApi,
  ScopeApi,
  SearchApi,
  SessionApi,
  SessionHit,
  SessionKind,
  ShellApi,
  SystemApi,
  WorkspaceHit,
  WorktreeApi,
  WorktreeEntry,
  WorktreeHold,
  WorktreeMigration,
  WorktreeOpening,
} from "../types";
import type {
  BranchChangeResult,
  BranchInfo,
  ChangeEntry,
  Commit,
  CommitState,
  PrLookup,
  RepoInfo,
} from "$lib/features/git/api";
import type { ChangedPath, DirEntry, SearchHit } from "$lib/features/explorer/api";
import type { FileVersions, TextFile } from "$lib/features/editor/api";
import type { Platform, ShellOption } from "$lib/storage/platform.svelte";
import type { LogEntry, LogLevel } from "$lib/shared/services/logger.svelte";

export const tauriGit: GitApi = {
  repoInfo: (path) => invoke<RepoInfo>("git_repo_info", { path }),
  findRepos: (path) => invoke<string[]>("git_find_repos", { path }),
  branches: (path) => invoke<BranchInfo[]>("git_branches", { path }),
  switchBranch: (path, name, create, stash) =>
    invoke<BranchChangeResult>("git_switch_branch", { path, name, create, stash }),
  status: (path) => invoke<ChangeEntry[]>("git_status", { path }),
  log: (path, limit, skip) => invoke<Commit[]>("git_log", { path, limit, skip }),
  commitState: (path, sha) => invoke<CommitState>("git_commit_state", { path, sha }),
  pullRequest: (path, branch) => invoke<PrLookup>("git_pull_request", { path, branch }),
  stage: (path, files) => invoke("git_stage", { path, files }),
  unstage: (path, files) => invoke("git_unstage", { path, files }),
  discard: (path, files, untracked) =>
    invoke("git_discard", { path, files, untracked }),
  commit: (path, message) => invoke<string>("git_commit", { path, message }),
  fetch: (path) => invoke("git_fetch", { path }),
  push: (path) => invoke("git_push", { path }),
  pull: (path) => invoke("git_pull", { path }),
  init: (path) => invoke("git_init", { path }),
};

export const tauriWorktree: WorktreeApi = {
  open: (repo, threadId) => invoke<WorktreeOpening>("worktree_open", { repo, threadId }),
  warm: (repo) => invoke<void>("worktree_warm", { repo }),
  migrate: (repo, threadId, from) =>
    invoke<WorktreeMigration>("worktree_migrate", { repo, threadId, from }),
  adopt: (repo, threadId) => invoke<string | null>("worktree_adopt", { repo, threadId }),
  recognize: (repo, path) => invoke<string | null>("worktree_recognize", { repo, path }),
  list: (repo) => invoke<WorktreeEntry[]>("worktree_list", { repo }),
  claim: (path, name) => invoke("worktree_claim", { path, name }),
  reserve: (path, name) => invoke("worktree_reserve", { path, name }),
  hold: (path) => invoke<WorktreeHold>("worktree_hold", { path }),
  remove: (repo, path, force) => invoke("worktree_remove", { repo, path, force }),
  sizes: (paths) => invoke<number[]>("worktree_sizes", { paths }),
};

export const tauriExplorer: ExplorerApi = {
  readDir: (path) => invoke<DirEntry[]>("read_dir", { path }),
  changedPaths: (path) => invoke<ChangedPath[]>("git_changed_paths", { path }),
  search: (path, query, limit) =>
    invoke<SearchHit[]>("explorer_search", { path, query, limit }),
};

export const tauriEditor: EditorApi = {
  readTextFile: (path) => invoke<TextFile>("read_text_file", { path }),
  writeTextFile: (path, content) =>
    invoke<number>("write_text_file", { path, content }),
  fileVersions: (path, file, headFile) =>
    invoke<FileVersions>("git_file_versions", { path, file, headFile }),
  readBase64: (path) => invoke<string>("read_file_base64", { path }),
};

export const tauriCheckpoints: CheckpointApi = {
  capture: (repo, threadId, edge) =>
    invoke<Checkpoint | null>("checkpoint_capture", { repo, threadId, edgeName: edge }),
  list: (repo, threadId) => invoke<Checkpoint[]>("checkpoint_list", { repo, threadId }),
  diff: (repo, from, to, patch) =>
    invoke<CheckpointDiff>("checkpoint_diff", { repo, from, to, patch }),
  fileVersions: (repo, from, to, file) =>
    invoke<CheckpointFileVersions>("checkpoint_file_versions", { repo, from, to, file }),
  restore: (repo, threadId, sha) =>
    invoke<void>("checkpoint_restore", { repo, threadId, sha }),
  forget: (repo, threadId) => invoke<void>("checkpoint_forget", { repo, threadId }),
};

export const tauriProject: ProjectApi = {
  inspect: (path) =>
    invoke<{ name: string; icon: string | null; tech: string | null }>(
      "inspect_project",
      { path },
    ),
  homeDir: () => invoke<string>("home_dir"),
  folderState: (path) => invoke<FolderState>("folder_state", { path }),
  createFolder: (path) => invoke<void>("create_project_folder", { path }),
};

// The desktop runs the threads itself, so the device's own OS is the right
// answer here and the plugin is the cheapest way to it.
export const tauriSystem: SystemApi = {
  async platform(): Promise<Platform> {
    const { platform } = await import("@tauri-apps/plugin-os");
    const raw = platform();
    return raw === "windows" || raw === "macos" || raw === "linux" ? raw : "unknown";
  },
};

interface RawShellOption {
  id: string;
  label: string;
  cmd: string;
  args: string[];
  icon_key: string | null;
}

export const tauriShell: ShellApi = {
  defaultShell: () => invoke<string>("default_shell"),
  warmShell: (shellId) => invoke<void>("pty_warm_shell", { shellId }),
  async availableShells(): Promise<ShellOption[]> {
    const list = await invoke<RawShellOption[]>("available_shells");
    return list.map((s) => ({
      id: s.id,
      label: s.label,
      cmd: s.cmd,
      args: s.args,
      iconKey: s.icon_key,
    }));
  },
  commandExists: (cmd) => invoke<boolean>("command_exists", { cmd }),
};

export const tauriFastpick: FastpickApi = {
  // The command hands back fastpick's document verbatim, so the parse happens here rather
  // than in Rust: one place that knows the shape, and it is the one that reads it.
  async list(provider, refresh) {
    const raw = await invoke<string>("fastpick_list", {
      provider: provider ?? null,
      refresh: refresh ?? false,
    });
    return JSON.parse(raw) as FastpickListing;
  },
  version: () => invoke<string | null>("fastpick_version"),
};

export const tauriCodexSwitcher: CodexSwitcherApi = {
  async list() {
    const raw = await invoke<string>("codex_switcher_list");
    return JSON.parse(raw) as CodexSwitcherList;
  },
  save: () => invoke("codex_switcher_save"),
  activate: (accountId) => invoke("codex_switcher_activate", { accountId }),
  version: () => invoke<string | null>("codex_switcher_version"),
};

export const tauriFastMcpSsh: FastMcpSshApi = {
  version: () => invoke<string | null>("fast_mcp_ssh_version"),
};

export const tauriKebaccSwitcher: KebaccSwitcherApi = {
  async list(provider) {
    const raw = await invoke<string>("kebacc_switcher_list", { provider: provider ?? null });
    return JSON.parse(raw) as KebaccSwitcherList;
  },
  async add(provider) {
    const raw = await invoke<string>("kebacc_switcher_add", { provider });
    return JSON.parse(raw) as KebaccSwitcherList;
  },
  async switchTo(provider, email) {
    const raw = await invoke<string>("kebacc_switcher_switch", { provider, email });
    return JSON.parse(raw) as KebaccSwitcherList;
  },
  version: () => invoke<string | null>("kebacc_switcher_version"),
};

export const tauriCli: CliApi = {
  catalog: (probeVersions) => invoke<CliRow[]>("cli_catalog", { probeVersions: probeVersions ?? false }),
  latest: () => invoke<CliLatest[]>("cli_latest"),
  jobs: () => invoke<CliJob[]>("cli_jobs"),
  dataPaths: (id) => invoke<CliDataPath[]>("cli_data_paths", { id }),
  install: (id) => invoke<CliJob>("cli_install", { id }),
  uninstall: (id, purgeData) => invoke<CliJob>("cli_uninstall", { id, purgeData }),
  cancel: (id) => invoke<boolean>("cli_cancel", { id }),
  dismiss: (id) => invoke<void>("cli_dismiss", { id }),
};

export const tauriMcp: McpApi = {
  catalog: () => invoke<McpServerRow[]>("mcp_catalog"),
};

export const tauriScope: ScopeApi = {
  registerProjectRoots: (roots) => invoke("register_project_roots", { roots }),
  // Desktop uses the native folder dialog, not a server-side browser.
  workspaceRoot: () => Promise.resolve(null),
};

const SESSION_COMMANDS: Record<SessionKind, string> = {
  claude: "find_claude_session",
  codex: "find_codex_session",
  opencode: "find_opencode_session",
  cursor: "find_cursor_session",
  antigravity: "find_antigravity_session",
  copilot: "find_copilot_session",
  grok: "find_grok_session",
  hermes: "find_hermes_session",
  pi: "find_pi_session",
};

export const tauriSession: SessionApi = {
  usage: (cwds, days, orchestratorSessions) =>
    invoke<UsageReport>("agent_token_usage", { cwds, days, orchestratorSessions }),
  liveClaude: () => invoke<LiveClaudeSession[]>("live_claude_sessions"),
  agentTurns: (queries) => invoke<AgentTurn[]>("agent_turns", { queries }),
  stopClaude: (sessionId) => invoke<boolean>("stop_claude_session", { sessionId }),
  copilotResumable: (sessionId) =>
    invoke<boolean>("copilot_session_resumable", { sessionId }),
  migrate: (kind, sessionId, fromCwd, toCwd) =>
    invoke<boolean>("migrate_session", { kind, sessionId, fromCwd, toCwd }),

  async find(kind, cwd, afterUnixMs, excludeIds, ptyId): Promise<SessionHit | null> {
    const command = SESSION_COMMANDS[kind];
    if (kind === "claude") {
      // Only claude keeps a registry of what it holds open, so only its
      // detector has a liveness filter to exempt the caller from.
      const hit = await invoke<{
        id: string;
        modifiedMs: number;
        ownPid: boolean;
      } | null>(command, {
        cwd,
        afterUnixMs,
        excludeIds,
        ptyId: ptyId ?? null,
      });
      return hit ? { id: hit.id, mtimeMs: hit.modifiedMs, ownPid: hit.ownPid } : null;
    }
    if (kind === "codex") {
      const hit = await invoke<{
        id: string;
        modifiedMs: number;
        title: string | null;
      } | null>(command, { cwd, afterUnixMs, excludeIds });
      return hit ? { id: hit.id, mtimeMs: hit.modifiedMs, title: hit.title } : null;
    }
    // The rest answer with an id and the activity timestamp their own store
    // keeps, which is null when that store had none to give, never a zero,
    // which attribution would read as 1970 and refuse.
    const hit = await invoke<{ id: string; modifiedMs: number | null; title?: string | null } | null>(command, {
      cwd,
      afterUnixMs,
      excludeIds,
    });
    return hit ? { id: hit.id, mtimeMs: hit.modifiedMs, title: hit.title } : null;
  },
};

export const tauriApprovals: ApprovalsApi = {
  list: () => invoke<PendingApproval[]>("approvals_open"),
  decide: (id, allow) => invoke<PendingApproval | null>("approval_decide", { id, allow }),
};

/** The webview resolving a browser question the host is holding open. */
export const tauriAnswerAgentRequest = (requestId: string, payload: Record<string, unknown>) =>
  invoke<void>("agent_answer", { requestId, payload });

/** The OS photographing a rectangle of this window, for the pane screenshot. */
export const tauriCapturePane = (rect: { x: number; y: number; w: number; h: number }) =>
  invoke<{ image: string; width: number; height: number }>("capture_pane", rect);

// Same bus command the remote asks for as `search.query`. The desktop reads the
// answer bare; the `hits` envelope is the WebSocket protocol's.
export const tauriSearch: SearchApi = {
  query: (text, limit) =>
    invoke<WorkspaceHit[]>("records_search", { params: { q: text, limit } }),
};

export const tauriLog: LogApi = {
  event: (level: LogLevel, source, message, details) =>
    invoke("log_app_event", { level, source, message, details }),
  read: (scope) => invoke<LogEntry[]>("read_app_log", { scope }),
  clear: () => invoke<void>("clear_app_log"),
  filePath: () => invoke<string>("log_file_path"),
};

/**
 * The bus's log, through this app's five commands.
 *
 * Every one of them is `boite_core::command::logs` reached by name, so what the
 * desktop reads and what a phone reads over the WebSocket is the same domain
 * answering. The desktop reads the answers bare; the `records` envelope belongs
 * to the WebSocket protocol.
 */
export const tauriLogs: LogsApi = {
  write: (records) => invoke<void>("logs_write", { params: { records } }),
  tail: (opts = {}) => invoke<LogRecord[]>("logs_tail", { params: opts }),
  query: (opts = {}) => invoke<LogRecord[]>("logs_query", { params: opts }),
  level: (directives) =>
    invoke<{ level: string }>("logs_level", {
      params: directives === undefined ? {} : { directives },
    }).then((r) => r.level ?? ""),
  // The host emits `log://record` in batches of fifty or every 250 ms, the same
  // numbers the server coalesces on. Told to start on the first handler and to
  // stop on the last: a window with the Logs section closed costs the log
  // nothing.
  subscribe: (handler) => {
    const handlers = desktopLogHandlers;
    handlers.add(handler);
    if (handlers.size === 1) startDesktopLogFeed();
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) stopDesktopLogFeed();
    };
  },
};

const desktopLogHandlers = new Set<(records: LogRecord[]) => void>();
let desktopLogStop: (() => void) | null = null;
let desktopLogEpoch = 0;

function startDesktopLogFeed() {
  const epoch = ++desktopLogEpoch;
  void invoke<void>("logs_subscribe", { params: { on: true } }).catch(() => {});
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ records?: LogRecord[] }>("log://record", (event) => {
        const records = event.payload?.records ?? [];
        if (records.length === 0) return;
        for (const handler of desktopLogHandlers) handler(records);
      }),
    )
    .then((un) => {
      // Unsubscribed while the dynamic import was in flight: drop the listener
      // rather than leaving one nothing can reach.
      if (epoch !== desktopLogEpoch) un();
      else desktopLogStop = un;
    })
    .catch(() => {});
}

function stopDesktopLogFeed() {
  desktopLogEpoch += 1;
  desktopLogStop?.();
  desktopLogStop = null;
  void invoke<void>("logs_subscribe", { params: { on: false } }).catch(() => {});
}

/**
 * The chat runtime, through this app's twelve commands.
 *
 * Every one of them is `boite_core::command::pilot` reached by name, so what
 * the desktop drives and what a phone drives over the WebSocket is the same
 * domain answering. The desktop reads the answers bare; the envelopes belong to
 * the WebSocket protocol.
 */
export const tauriPilot: PilotApi = {
  catalog: (refresh = false) =>
    invoke<PilotCatalog>("pilot_catalog", { params: { refresh } }),
  open: (threadId) => invoke<PilotOpened>("pilot_thread_open", { params: { threadId } }),
  startTurn: (threadId, text, selection) =>
    invoke<{ turnId: string }>("pilot_turn_start", {
      params: { threadId, text, model: selection ?? null },
    }).then((r) => r.turnId ?? ""),
  interrupt: (threadId) =>
    invoke<unknown>("pilot_turn_interrupt", { params: { threadId } }).then(() => {}),
  respond: (threadId, requestId, answer) =>
    invoke<unknown>("pilot_request_respond", {
      params: { threadId, requestId, option: answer },
    }).then(() => {}),
  setModel: (threadId, selection) =>
    invoke<{ switch: PilotSwitchKind }>("pilot_model_set", {
      params: {
        threadId,
        model: selection.model ?? null,
        instance: selection.instance ?? null,
      },
    }).then((r) => r.switch),
  setMode: (threadId, mode) =>
    invoke<unknown>("pilot_mode_set", { params: { threadId, mode } }).then(() => {}),
  stop: (threadId) =>
    invoke<unknown>("pilot_session_stop", { params: { threadId } }).then(() => {}),
  items: (threadId, afterSeq = 0, limit) =>
    invoke<PilotItemRow[]>("pilot_items", { params: { threadId, afterSeq, limit } }),
  events: (threadId, afterSeq = 0, limit) =>
    invoke<PilotEventRow[]>("pilot_events", { params: { threadId, afterSeq, limit } }),
  // One window event for every thread, carrying `{threadId, event}`: a pane
  // filters on the id it draws. A channel per pane would mean the sink knowing
  // which panes exist, which is the window's business and not the host's.
  subscribe: (threadId, handler) => {
    let handlers = pilotHandlers.get(threadId);
    if (!handlers) {
      handlers = new Set();
      pilotHandlers.set(threadId, handlers);
      void invoke<void>("pilot_subscribe", { params: { threadId } }).catch((err) => {
        log.warn("backend.pilot", "pilot.subscribe.refused", {
          thread: threadId,
          reason: String(err),
        });
      });
    }
    handlers.add(handler);
    startPilotFeed();
    return () => {
      const held = pilotHandlers.get(threadId);
      if (!held) return;
      held.delete(handler);
      if (held.size > 0) return;
      pilotHandlers.delete(threadId);
      void invoke<void>("pilot_unsubscribe", { params: { threadId } }).catch((err) => {
        log.warn("backend.pilot", "pilot.unsubscribe.refused", {
          thread: threadId,
          reason: String(err),
        });
      });
      if (pilotHandlers.size === 0) stopPilotFeed();
    };
  },
};

/** Handlers per thread. The window listens once, whatever is open. */
const pilotHandlers = new Map<string, Set<(event: PilotEvent) => void>>();
let pilotStop: (() => void) | null = null;
let pilotEpoch = 0;

function startPilotFeed() {
  if (pilotStop) return;
  const epoch = ++pilotEpoch;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ threadId?: string; event?: PilotEvent }>("pilot://event", (message) => {
        const threadId = message.payload?.threadId;
        const event = message.payload?.event;
        if (!threadId || !event) return;
        const handlers = pilotHandlers.get(threadId);
        if (!handlers) return;
        for (const handler of handlers) handler(event);
      }),
    )
    .then((un) => {
      // Unsubscribed while the dynamic import was in flight: drop the listener
      // rather than leaving one nothing can reach.
      if (epoch !== pilotEpoch) un();
      else pilotStop = un;
    })
    .catch((err) => {
      log.warn("backend.pilot", "pilot.feed.failed", { reason: String(err) });
    });
}

function stopPilotFeed() {
  pilotEpoch += 1;
  pilotStop?.();
  pilotStop = null;
}

/**
 * Carrying the agent configuration between computers.
 *
 * Every one of these is the same bus command the remote asks for by name; the
 * desktop reads the answer bare, and the envelopes belong to the WebSocket
 * protocol. The address and the switches are not passed: the host reads them out
 * of the settings row, so what is on screen and what the next sync uses cannot
 * disagree.
 */
export const tauriTelemetry: TelemetryApi = {
  state: () => invoke<TelemetryState>("telemetry_state"),
  setModeA: (enabled) => invoke("telemetry_set_mode_a", { params: { enabled } }),
  setModeB: (enabled) => invoke("telemetry_set_mode_b", { params: { enabled } }),
  completeOnboarding: (modeA, modeB) =>
    invoke("telemetry_complete_onboarding", { params: { modeA, modeB } }),
  export: () => invoke<unknown>("telemetry_export"),
  retryForget: () => invoke("telemetry_retry_forget"),
  trackUpdate: ({ stage, targetVersion, errorCode }) =>
    invoke("telemetry_track_update", { params: { stage, targetVersion, errorCode } }),
  trackPane: (paneKind) => invoke("telemetry_track_pane", { params: { paneKind } }),
  trackSettingsSnapshot: (args) =>
    invoke("telemetry_track_settings_snapshot", { params: args }),
};

export const tauriSync: SyncApi = {
  sources: () => invoke<SyncSource[]>("sync_sources"),
  status: () => invoke<SyncStatus>("sync_status"),
  probe: (remoteUrl) => invoke<SyncProbe>("sync_probe", { params: { remoteUrl } }),
  pull: () => invoke<SyncConflict[]>("sync_pull"),
  conflicts: () => invoke<SyncConflict[]>("sync_conflicts"),
  resolve: (path, content) => invoke<SyncJob>("sync_resolve", { params: { path, content } }),
  skip: (path) => invoke<SyncJob>("sync_skip", { params: { path } }),
  push: () => invoke<SyncJob>("sync_push"),
  cancel: () => invoke<boolean>("sync_cancel"),
  dismiss: () => invoke<void>("sync_dismiss"),
  repair: () => invoke<void>("sync_repair"),
};
