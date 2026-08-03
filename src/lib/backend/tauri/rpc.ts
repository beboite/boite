import { invoke } from "@tauri-apps/api/core";
import type {
  EditorApi,
  ExplorerApi,
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
  SessionApi,
  SessionHit,
  SessionKind,
  ShellApi,
  SystemApi,
  WorktreeApi,
  WorktreeEntry,
  WorktreeHold,
  WorktreeMigration,
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
  open: (repo, threadId) => invoke<string | null>("worktree_open", { repo, threadId }),
  warm: (repo) => invoke<void>("worktree_warm", { repo }),
  migrate: (repo, threadId, from) =>
    invoke<WorktreeMigration>("worktree_migrate", { repo, threadId, from }),
  list: (repo) => invoke<WorktreeEntry[]>("worktree_list", { repo }),
  claim: (path, name) => invoke("worktree_claim", { path, name }),
  reserve: (path, name) => invoke("worktree_reserve", { path, name }),
  hold: (path) => invoke<WorktreeHold>("worktree_hold", { path }),
  remove: (repo, path, force) => invoke("worktree_remove", { repo, path, force }),
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
};

export const tauriSession: SessionApi = {
  usage: (cwds, days) => invoke<UsageReport>("agent_token_usage", { cwds, days }),
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
      const hit = await invoke<{ id: string; modifiedMs: number } | null>(command, {
        cwd,
        afterUnixMs,
        excludeIds,
        ptyId: ptyId ?? null,
      });
      return hit ? { id: hit.id, mtimeMs: hit.modifiedMs } : null;
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
    // keeps, which is null when that store had none to give — never a zero,
    // which attribution would read as 1970 and refuse.
    const hit = await invoke<{ id: string; modifiedMs: number | null } | null>(command, {
      cwd,
      afterUnixMs,
      excludeIds,
    });
    return hit ? { id: hit.id, mtimeMs: hit.modifiedMs } : null;
  },
};

export const tauriLog: LogApi = {
  event: (level: LogLevel, source, message, details) =>
    invoke("log_app_event", { level, source, message, details }),
  read: (scope) => invoke<LogEntry[]>("read_app_log", { scope }),
  clear: () => invoke<void>("clear_app_log"),
  filePath: () => invoke<string>("log_file_path"),
};
