import {
  gitCommit,
  gitDiscard,
  gitFetch,
  gitLog,
  gitRepoInfo,
  gitStage,
  gitStatus,
  gitUnstage,
  type ChangeEntry,
  type Commit,
} from "./api";
import { notifications } from "$lib/features/notifications/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";

const LOG_PAGE = 80;
// Cap the exponential backoff at 2^4 = 16x the configured period so a repo
// that keeps failing (offline, bad creds) retries at most ~once per period*16
// instead of hammering the network or popping credential prompts.
const MAX_BACKOFF_SHIFT = 4;

interface RefreshOptions {
  reloadLog?: boolean;
  notifyErrors?: boolean;
}

export interface GitState {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  refsVersion: string | null;
  staged: ChangeEntry[];
  unstaged: ChangeEntry[];
  conflicts: ChangeEntry[];
  log: Commit[];
  logHasMore: boolean;
  logLoadingMore: boolean;
  loading: boolean;
  committing: boolean;
  fetching: boolean;
  message: string;
}

function emptyState(): GitState {
  return {
    isRepo: false,
    branch: null,
    ahead: 0,
    behind: 0,
    refsVersion: null,
    staged: [],
    unstaged: [],
    conflicts: [],
    log: [],
    logHasMore: false,
    logLoadingMore: false,
    loading: false,
    committing: false,
    fetching: false,
    message: "",
  };
}

class GitStore {
  states = $state<Record<string, GitState>>({});
  cwds = new Map<string, string>();
  private inflight = new Map<string, Promise<void>>();
  private pendingReloadLog = new Set<string>();
  private lastFetchAt = new Map<string, number>();
  private fetchFails = new Map<string, number>();

  ensure(projectId: string, cwd: string): GitState {
    this.cwds.set(projectId, cwd);
    if (!this.states[projectId]) {
      this.states[projectId] = emptyState();
    }
    return this.states[projectId];
  }

  get(projectId: string | null): GitState | null {
    if (!projectId) return null;
    return this.states[projectId] ?? null;
  }

  drop(projectId: string) {
    delete this.states[projectId];
    this.cwds.delete(projectId);
    this.lastFetchAt.delete(projectId);
    this.fetchFails.delete(projectId);
  }

  async refresh(
    projectId: string,
    options: RefreshOptions = {},
  ): Promise<void> {
    const cwd = this.cwds.get(projectId);
    if (!cwd) return;
    const existing = this.inflight.get(projectId);
    if (existing) {
      if (!options.reloadLog) return existing;
      this.pendingReloadLog.add(projectId);
      return existing.catch(() => undefined).then(() => {
        if (!this.pendingReloadLog.has(projectId)) return;
        this.pendingReloadLog.delete(projectId);
        return this.refresh(projectId, options);
      });
    }

    const state = this.ensure(projectId, cwd);
    state.loading = true;
    const previous = {
      isRepo: state.isRepo,
      branch: state.branch,
      ahead: state.ahead,
      behind: state.behind,
      refsVersion: state.refsVersion,
    };

    const task = (async () => {
      try {
        const [info, entries] = await Promise.all([
          gitRepoInfo(cwd),
          gitStatus(cwd),
        ]);
        const shouldLoadLog =
          options.reloadLog ||
          state.log.length === 0 ||
          previous.isRepo !== info.isRepo ||
          previous.branch !== info.branch ||
          previous.ahead !== info.ahead ||
          previous.behind !== info.behind ||
          previous.refsVersion !== info.refsVersion;
        const log = info.isRepo && shouldLoadLog ? await gitLog(cwd, LOG_PAGE, 0) : null;
        state.isRepo = info.isRepo;
        state.branch = info.branch;
        state.ahead = info.ahead;
        state.behind = info.behind;
        state.refsVersion = info.refsVersion;
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
        console.error("git refresh failed:", err);
        if (options.notifyErrors) throw err;
      } finally {
        state.loading = false;
        this.inflight.delete(projectId);
      }
    })();
    this.inflight.set(projectId, task);
    return task;
  }

  async loadMore(projectId: string): Promise<void> {
    const cwd = this.cwds.get(projectId);
    const state = this.states[projectId];
    if (!cwd || !state || state.logLoadingMore || !state.logHasMore) return;
    state.logLoadingMore = true;
    try {
      const rows = await gitLog(cwd, LOG_PAGE, state.log.length);
      const existing = new Set(state.log.map((c) => c.sha));
      state.log = [...state.log, ...rows.filter((c) => !existing.has(c.sha))];
      state.logHasMore = rows.length === LOG_PAGE;
    } catch (err) {
      notifications.error(`Load commits failed: ${err}`);
    } finally {
      state.logLoadingMore = false;
    }
  }

  async stage(projectId: string, files: string[]) {
    const cwd = this.cwds.get(projectId);
    if (!cwd || files.length === 0) return;
    try {
      await gitStage(cwd, files);
      await this.refresh(projectId);
    } catch (err) {
      notifications.error(`Stage failed: ${err}`);
    }
  }

  async unstage(projectId: string, files: string[]) {
    const cwd = this.cwds.get(projectId);
    if (!cwd || files.length === 0) return;
    try {
      await gitUnstage(cwd, files);
      await this.refresh(projectId);
    } catch (err) {
      notifications.error(`Unstage failed: ${err}`);
    }
  }

  async discard(projectId: string, files: string[]) {
    const cwd = this.cwds.get(projectId);
    if (!cwd || files.length === 0) return;
    try {
      await gitDiscard(cwd, files);
      await this.refresh(projectId);
    } catch (err) {
      notifications.error(`Discard failed: ${err}`);
    }
  }

  // Manual fetch (button). Always runs, ignores the rate-limit gap, surfaces
  // errors, and resets the backoff counter on success.
  async fetch(projectId: string) {
    const cwd = this.cwds.get(projectId);
    const state = this.states[projectId];
    if (!cwd || !state || state.fetching) return;
    await this.runFetch(projectId, cwd, state, true);
  }

  // Background fetch (timer/focus). Self-gated by an exponential backoff window
  // so it never double-fetches or spams a failing remote.
  async autoFetch(projectId: string) {
    if (!settings.state.gitAutoFetch) return;
    const cwd = this.cwds.get(projectId);
    const state = this.states[projectId];
    if (!cwd || !state || !state.isRepo || state.fetching) return;
    const baseMs =
      Math.max(30, settings.state.gitAutoFetchSeconds) * 1000;
    const shift = Math.min(this.fetchFails.get(projectId) ?? 0, MAX_BACKOFF_SHIFT);
    const gap = baseMs * 2 ** shift;
    const last = this.lastFetchAt.get(projectId) ?? 0;
    if (Date.now() - last < gap) return;
    await this.runFetch(projectId, cwd, state, false);
  }

  private async runFetch(
    projectId: string,
    cwd: string,
    state: GitState,
    manual: boolean,
  ) {
    state.fetching = true;
    // Stamp before awaiting so the rate-limit window holds even if the fetch
    // fails or hangs, preventing a retry storm.
    this.lastFetchAt.set(projectId, Date.now());
    try {
      await gitFetch(cwd);
      this.fetchFails.delete(projectId);
      await this.refresh(projectId, { reloadLog: true, notifyErrors: manual });
    } catch (err) {
      this.fetchFails.set(projectId, (this.fetchFails.get(projectId) ?? 0) + 1);
      if (manual) notifications.error(`Fetch failed: ${err}`);
      else console.error("git auto-fetch failed:", err);
    } finally {
      state.fetching = false;
    }
  }

  async commit(projectId: string) {
    const cwd = this.cwds.get(projectId);
    const state = this.states[projectId];
    if (!cwd || !state) return;
    const msg = state.message.trim();
    if (!msg) {
      notifications.error("Commit message is empty");
      return;
    }
    if (state.staged.length === 0) {
      notifications.error("No staged changes");
      return;
    }
    state.committing = true;
    try {
      await gitCommit(cwd, msg);
      state.message = "";
      notifications.success("Commit created");
      await this.refresh(projectId, { reloadLog: true });
    } catch (err) {
      notifications.error(`Commit failed: ${err}`);
    } finally {
      state.committing = false;
    }
  }
}

export const gitStore = new GitStore();
