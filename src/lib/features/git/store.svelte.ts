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

const LOG_PAGE = 80;

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

  async fetch(projectId: string) {
    const cwd = this.cwds.get(projectId);
    const state = this.states[projectId];
    if (!cwd || !state) return;
    if (state.fetching) return;
    state.fetching = true;
    try {
      await gitFetch(cwd);
      await this.refresh(projectId, { reloadLog: true, notifyErrors: true });
    } catch (err) {
      notifications.error(`Fetch failed: ${err}`);
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
