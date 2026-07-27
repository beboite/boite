import { invoke } from "@tauri-apps/api/core";
import type {
  EditorApi,
  ExplorerApi,
  GitApi,
  LiveClaudeSession,
  LogApi,
  ProjectApi,
  ScopeApi,
  SessionApi,
  SessionHit,
  SessionKind,
  ShellApi,
} from "../types";
import type {
  BranchChangeResult,
  BranchInfo,
  ChangeEntry,
  Commit,
  CommitState,
  PullRequest,
  RepoInfo,
} from "$lib/features/git/api";
import type { ChangedPath, DirEntry, SearchHit } from "$lib/features/explorer/api";
import type { FileVersions, TextFile } from "$lib/features/editor/api";
import type { ShellOption } from "$lib/storage/platform.svelte";
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
  pullRequest: (path, branch) =>
    invoke<PullRequest | null>("git_pull_request", { path, branch }),
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
};

export const tauriProject: ProjectApi = {
  inspect: (path) =>
    invoke<{ name: string; icon: string | null; tech: string | null }>(
      "inspect_project",
      { path },
    ),
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
  liveClaude: () => invoke<LiveClaudeSession[]>("live_claude_sessions"),
  stopClaude: (sessionId) => invoke<boolean>("stop_claude_session", { sessionId }),
  copilotResumable: (sessionId) =>
    invoke<boolean>("copilot_session_resumable", { sessionId }),

  async find(kind, cwd, afterUnixMs, excludeIds): Promise<SessionHit | null> {
    const command = SESSION_COMMANDS[kind];
    if (kind === "claude") {
      const hit = await invoke<{ id: string; modifiedMs: number } | null>(command, {
        cwd,
        afterUnixMs,
        excludeIds,
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
    const id = await invoke<string | null>(command, { cwd, afterUnixMs, excludeIds });
    return id ? { id, mtimeMs: null } : null;
  },
};

export const tauriLog: LogApi = {
  event: (level: LogLevel, source, message, details) =>
    invoke("log_app_event", { level, source, message, details }),
  read: (scope) => invoke<LogEntry[]>("read_app_log", { scope }),
  clear: () => invoke<void>("clear_app_log"),
  filePath: () => invoke<string>("log_file_path"),
};
