import {
  gitBranches,
  gitCommit,
  gitDiscard,
  gitFetch,
  gitFindRepos,
  gitInit,
  gitLog,
  gitPull,
  gitPush,
  gitRepoInfo,
  gitStage,
  gitStatus,
  gitSwitchBranch,
  gitUnstage,
  type BranchInfo,
  type ChangeEntry,
  type Commit,
} from "./api";
import { untrack } from "svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";

const LOG_PAGE = 80;
// The graph renders every loaded commit as SVG lanes and edges, and nothing
// ever drops rows again, so "load more" was a one-way ratchet on both memory
// and per-frame layout cost. Stop paging well before that hurts.
const LOG_MAX = 1000;
// Cap the exponential backoff at 2^4 = 16x the configured period so a repo
// that keeps failing (offline, bad creds) retries at most ~once per period*16
// instead of hammering the network or popping credential prompts.
const MAX_BACKOFF_SHIFT = 4;

interface RefreshOptions {
  reloadLog?: boolean;
  notifyErrors?: boolean;
}

/**
 * A project id is not enough to name a checkout. Switching to a thread that
 * lives in a worktree re-targets the same project at another directory, and the
 * dashboard keeps describing the project folder while the panel describes the
 * worktree, two answers that are both right about different paths.
 *
 * So the state is keyed by the pair. Two readers asking about two directories
 * get two states instead of resetting each other's, which is what turned a
 * dashboard plus an open git panel into an unbounded reset loop: `ensure` wrote
 * the same `$state` entry its caller had just read.
 */
export type GitScope = string;

export function gitScope(projectId: string, cwd: string): GitScope {
  return `${projectId} ${cwd}`;
}

function scopeProjectId(scope: GitScope): string {
  const cut = scope.indexOf(" ");
  return cut < 0 ? scope : scope.slice(0, cut);
}

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  refsVersion: string | null;
  commitCount: number;
  branches: BranchInfo[];
  branchesLoaded: boolean;
  branchesLoading: boolean;
  switchingBranch: boolean;
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  conflicts: ChangeEntry[];
  log: Commit[];
  logHasMore: boolean;
  logLoadingMore: boolean;
  /** Nested repos discovered under the project folder when it isn't one. */
  repos: string[];
  scanning: boolean;
  /** True once the first refresh has completed; gates the initial spinner. */
  loaded: boolean;
  loading: boolean;
  /**
   * Why the last refresh failed, or null. Without it a failed refresh left the
   * previous staged/unstaged lists on screen and said nothing, so a repo that
   * had moved or a git binary that had gone read as "no changes".
   */
  error: string | null;
  committing: boolean;
  fetching: boolean;
  pushing: boolean;
  pulling: boolean;
  message: string;
}

function emptyState(): GitState {
  return {
    isRepo: false,
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    refsVersion: null,
    commitCount: 0,
    branches: [],
    branchesLoaded: false,
    branchesLoading: false,
    switchingBranch: false,
    staged: [],
    unstaged: [],
    conflicts: [],
    log: [],
    logHasMore: false,
    logLoadingMore: false,
    repos: [],
    scanning: false,
    loaded: false,
    loading: false,
    error: null,
    committing: false,
    fetching: false,
    pushing: false,
    pulling: false,
    message: "",
  };
}

class GitStore {
  states = $state<Record<GitScope, GitState>>({});
  cwds = new Map<GitScope, string>();
  private inflight = new Map<GitScope, Promise<void>>();
  private pendingReloadLog = new Set<GitScope>();
  private lastFetchAt = new Map<GitScope, number>();
  private fetchFails = new Map<GitScope, number>();
  // Base path last scanned per scope, so the effect that triggers the scan
  // doesn't loop; a changed base (project switch, root cleared) rescans.
  private scannedBase = new Map<GitScope, string>();

  /**
   * Register a checkout and return the scope naming it. Safe to call from an
   * effect: the read and the write both run untracked, so creating the entry
   * never invalidates the effect that asked for it.
   */
  ensure(projectId: string, cwd: string): GitScope {
    const scope = gitScope(projectId, cwd);
    untrack(() => {
      this.cwds.set(scope, cwd);
      if (!this.states[scope]) this.states[scope] = emptyState();
    });
    return scope;
  }

  get(scope: GitScope | null): GitState | null {
    if (!scope) return null;
    return this.states[scope] ?? null;
  }

  /** Every checkout of a project, dropped together when the project goes. */
  drop(projectId: string) {
    for (const scope of Object.keys(this.states)) {
      if (scopeProjectId(scope) !== projectId) continue;
      delete this.states[scope];
      this.cwds.delete(scope);
      this.lastFetchAt.delete(scope);
      this.fetchFails.delete(scope);
      this.scannedBase.delete(scope);
    }
  }

  // Drop every cached repo so a workspace switch starts clean.
  reset() {
    this.states = {};
    this.cwds.clear();
    this.inflight.clear();
    this.pendingReloadLog.clear();
    this.lastFetchAt.clear();
    this.fetchFails.clear();
    this.scannedBase.clear();
  }

  // Scan the project folder for nested git repos so the panel can offer them
  // when the folder itself isn't a repo. Idempotent per (project, base).
  async scanRepos(scope: GitScope, basePath: string) {
    const state = this.states[scope];
    if (!state || state.scanning) return;
    if (this.scannedBase.get(scope) === basePath) return;
    this.scannedBase.set(scope, basePath);
    state.scanning = true;
    try {
      state.repos = await gitFindRepos(basePath);
    } catch (err) {
      logger.error("git", "repo scan failed", err);
      state.repos = [];
    } finally {
      state.scanning = false;
    }
  }

  async refresh(
    scope: GitScope | null,
    options: RefreshOptions = {},
  ): Promise<void> {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state) return;
    const existing = this.inflight.get(scope);
    if (existing) {
      if (!options.reloadLog) return existing;
      this.pendingReloadLog.add(scope);
      return existing.catch(() => undefined).then(() => {
        if (!this.pendingReloadLog.has(scope)) return;
        this.pendingReloadLog.delete(scope);
        return this.refresh(scope, options);
      });
    }

    state.loading = true;
    // Untracked: `refresh` is called straight from an effect, so a plain read
    // here would make that effect depend on the very fields the refresh is
    // about to write, and every poll would fire a duplicate round trip.
    const previous = untrack(() => ({
      isRepo: state.isRepo,
      branch: state.branch,
      ahead: state.ahead,
      behind: state.behind,
      refsVersion: state.refsVersion,
      hasLog: state.log.length > 0,
    }));

    const task = (async () => {
      try {
        const [info, entries] = await Promise.all([
          gitRepoInfo(cwd),
          gitStatus(cwd),
        ]);
        const shouldLoadLog =
          options.reloadLog ||
          !previous.hasLog ||
          previous.isRepo !== info.isRepo ||
          previous.branch !== info.branch ||
          previous.ahead !== info.ahead ||
          previous.behind !== info.behind ||
          previous.refsVersion !== info.refsVersion;
        const log = info.isRepo && shouldLoadLog ? await gitLog(cwd, LOG_PAGE, 0) : null;
        state.error = null;
        state.isRepo = info.isRepo;
        state.branch = info.branch;
        state.upstream = info.upstream;
        state.ahead = info.ahead;
        state.behind = info.behind;
        state.refsVersion = info.refsVersion;
        state.commitCount = info.commitCount;
        if (previous.branch !== info.branch && state.branchesLoaded) {
          void this.loadBranches(scope, false);
        }
        const staged: ChangeEntry[] = [];
        const unstaged: ChangeEntry[] = [];
        const conflicts: ChangeEntry[] = [];
        for (const e of entries) {
          if (e.conflicted) conflicts.push(e);
          else if (e.staged) staged.push(e);
          else unstaged.push(e);
        }
        state.staged = staged;
        state.unstaged = unstaged;
        state.conflicts = conflicts;
        if (log) {
          state.log = log;
          state.logHasMore = log.length === LOG_PAGE;
        } else if (!info.isRepo) {
          state.log = [];
          state.logHasMore = false;
        }
      } catch (err) {
        // Only when it changes. This refresh is on a ten-second poll, so a
        // project whose folder stopped being a repository wrote the same line
        // six times a minute for as long as the app was open, and the lines
        // that mattered were somewhere in between. The panel reports the
        // failure through `state.error` either way.
        const text = errorText(err);
        if (state.error !== text) logger.error("git", "refresh failed", err);
        state.error = text;
        if (options.notifyErrors) throw err;
      } finally {
        state.loaded = true;
        state.loading = false;
        this.inflight.delete(scope);
      }
    })();
    this.inflight.set(scope, task);
    return task;
  }

  async loadMore(scope: GitScope | null): Promise<void> {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.logLoadingMore || !state.logHasMore) return;
    if (state.log.length >= LOG_MAX) {
      state.logHasMore = false;
      return;
    }
    state.logLoadingMore = true;
    try {
      const rows = await gitLog(cwd, LOG_PAGE, state.log.length);
      const existing = new Set(state.log.map((c) => c.sha));
      const merged = [...state.log, ...rows.filter((c) => !existing.has(c.sha))];
      state.log = merged.length > LOG_MAX ? merged.slice(0, LOG_MAX) : merged;
      state.logHasMore = rows.length === LOG_PAGE && state.log.length < LOG_MAX;
    } catch (err) {
      notifications.error(t("git.loadCommitsFailed", { error: String(err) }));
    } finally {
      state.logLoadingMore = false;
    }
  }

  async loadBranches(scope: GitScope | null, notifyErrors = true): Promise<void> {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.branchesLoading) return;
    state.branchesLoading = true;
    try {
      state.branches = await gitBranches(cwd);
      state.branchesLoaded = true;
    } catch (err) {
      if (notifyErrors) {
        notifications.error(
          t("git.loadBranchesFailed", { error: branchError(err) }),
        );
      }
    } finally {
      state.branchesLoading = false;
    }
  }

  async changeBranch(
    scope: GitScope | null,
    name: string,
    create: boolean,
    stash: boolean,
  ): Promise<boolean> {
    if (!scope) return false;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.switchingBranch) return false;
    state.switchingBranch = true;
    try {
      const result = await gitSwitchBranch(cwd, name, create, stash);
      notifications.success(
        result.stashed
          ? t("git.switchedStashed", { branch: name })
          : create
            ? t("git.branchCreated", { branch: name })
            : t("git.switched", { branch: name }),
      );
      await Promise.all([
        this.refresh(scope, { reloadLog: true, notifyErrors: true }),
        this.loadBranches(scope, false),
      ]);
      return true;
    } catch (err) {
      notifications.error(branchError(err));
      await this.refresh(scope);
      return false;
    } finally {
      state.switchingBranch = false;
    }
  }

  async stage(scope: GitScope | null, files: string[]) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    if (!cwd || files.length === 0) return;
    try {
      await gitStage(cwd, files);
      await this.refresh(scope);
    } catch (err) {
      notifications.error(t("git.stageFailed", { error: String(err) }));
    }
  }

  async unstage(scope: GitScope | null, files: string[]) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    if (!cwd || files.length === 0) return;
    try {
      await gitUnstage(cwd, files);
      await this.refresh(scope);
    } catch (err) {
      notifications.error(t("git.unstageFailed", { error: String(err) }));
    }
  }

  async discard(scope: GitScope | null, entries: Pick<ChangeEntry, "path" | "status">[]) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    if (!cwd || entries.length === 0) return;
    const tracked = entries.filter((e) => e.status !== "?").map((e) => e.path);
    const untracked = entries.filter((e) => e.status === "?").map((e) => e.path);
    try {
      await gitDiscard(cwd, tracked, untracked);
      await this.refresh(scope);
    } catch (err) {
      notifications.error(t("git.discardFailed", { error: String(err) }));
    }
  }

  async push(scope: GitScope | null) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.pushing) return;
    state.pushing = true;
    try {
      await gitPush(cwd);
      notifications.success(t("git.pushed"));
      await this.refresh(scope, { reloadLog: true });
    } catch (err) {
      notifications.error(t("git.pushFailed", { error: String(err) }));
    } finally {
      state.pushing = false;
    }
  }

  async pull(scope: GitScope | null) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.pulling) return;
    state.pulling = true;
    try {
      await gitPull(cwd);
      notifications.success(t("git.pulled"));
      await this.refresh(scope, { reloadLog: true });
    } catch (err) {
      notifications.error(t("git.pullFailed", { error: String(err) }));
    } finally {
      state.pulling = false;
    }
  }

  async init(scope: GitScope | null) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    if (!cwd) return;
    try {
      await gitInit(cwd);
      notifications.success(t("git.repoInitialized"));
      await this.refresh(scope, { reloadLog: true });
    } catch (err) {
      notifications.error(t("git.initFailed", { error: String(err) }));
    }
  }

  // Manual fetch (button). Always runs, ignores the rate-limit gap, surfaces
  // errors, and resets the backoff counter on success.
  async fetch(scope: GitScope | null) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || state.fetching) return;
    await this.runFetch(scope, cwd, state, true);
  }

  // Background fetch (timer/focus). Self-gated by an exponential backoff window
  // so it never double-fetches or spams a failing remote.
  async autoFetch(scope: GitScope | null) {
    if (!settings.state.gitAutoFetch) return;
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state || !state.isRepo || state.fetching) return;
    const baseMs =
      Math.max(30, settings.state.gitAutoFetchSeconds) * 1000;
    const shift = Math.min(this.fetchFails.get(scope) ?? 0, MAX_BACKOFF_SHIFT);
    const gap = baseMs * 2 ** shift;
    const last = this.lastFetchAt.get(scope) ?? 0;
    if (Date.now() - last < gap) return;
    await this.runFetch(scope, cwd, state, false);
  }

  private async runFetch(
    scope: GitScope,
    cwd: string,
    state: GitState,
    manual: boolean,
  ) {
    state.fetching = true;
    // Stamp before awaiting so the rate-limit window holds even if the fetch
    // fails or hangs, preventing a retry storm.
    this.lastFetchAt.set(scope, Date.now());
    try {
      await gitFetch(cwd);
      this.fetchFails.delete(scope);
      await this.refresh(scope, { reloadLog: true, notifyErrors: manual });
    } catch (err) {
      this.fetchFails.set(scope, (this.fetchFails.get(scope) ?? 0) + 1);
      if (manual) notifications.error(t("git.fetchFailed", { error: String(err) }));
      else logger.warn("git", "auto-fetch failed", String(err));
    } finally {
      state.fetching = false;
    }
  }

  async commit(scope: GitScope | null) {
    if (!scope) return;
    const cwd = this.cwds.get(scope);
    const state = this.states[scope];
    if (!cwd || !state) return;
    const msg = state.message.trim();
    if (!msg) {
      notifications.error(t("git.commitEmpty"));
      return;
    }
    if (state.staged.length === 0) {
      notifications.error(t("git.noStagedChanges"));
      return;
    }
    state.committing = true;
    try {
      await gitCommit(cwd, msg);
      state.message = "";
      notifications.success(t("git.commitCreated"));
      await this.refresh(scope, { reloadLog: true });
    } catch (err) {
      notifications.error(t("git.commitFailed", { error: String(err) }));
    } finally {
      state.committing = false;
    }
  }
}

export const gitStore = new GitStore();

function errorText(error: unknown): string {
  return String(error).replace(/^Error:\s*/i, "").trim() || "git failed";
}

function branchError(error: unknown): string {
  const message = String(error).replace(/^Error:\s*/i, "").trim();
  const lower = message.toLowerCase();
  if (
    lower.includes("would be overwritten by checkout") ||
    lower.includes("would be overwritten by switch") ||
    lower.includes("local changes to the following files")
  ) {
    return t("git.branchWouldOverwrite");
  }
  if (
    lower.includes("resolve your current index first") ||
    lower.includes("cannot switch branch while") ||
    lower.includes("you are in the middle of") ||
    lower.includes("needs merge") ||
    lower.includes("unmerged files")
  ) {
    return t("git.branchMidOperation");
  }
  if (
    lower.includes("already checked out at") ||
    lower.includes("already used by worktree")
  ) {
    return t("git.branchInUse");
  }
  if (lower.includes("index.lock")) {
    return t("git.branchIndexLock");
  }
  if (lower.includes("not a git repository")) {
    return t("git.branchNoRepo");
  }
  return message || t("git.branchChangeFailed");
}
