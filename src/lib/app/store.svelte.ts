import type {
  MobileTab,
  Project,
  Thread,
  ThreadStatus,
  View,
  WorkspaceOrigin,
} from "$lib/types";
import {
  saveThread,
  updateThreadTitle,
  markThreadStarted,
  deleteThread as dbDeleteThread,
} from "$lib/storage/db";
import { settings } from "$lib/features/settings/store.svelte";
import { device } from "$lib/features/settings/device.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { platform } from "$lib/storage/platform.svelte";
import {
  clearRenamed,
  isRenamed,
  markRenamed,
  pruneRenamed,
} from "$lib/features/thread/renamed";
import { noteStatusChange, resetFinished } from "$lib/features/thread/finished.svelte";
import {
  forgetThreadActivity,
  threadActivitySince,
} from "$lib/features/thread/activity.svelte";
import { SCRATCH_PROJECT_ID } from "$lib/domain/project";
import { notifications } from "$lib/features/notifications/store.svelte";
import { backend, workspace } from "$lib/backend";
import { applyControlEvent } from "./control-events";
import { loadRows, resyncFromServer, syncRoots } from "./hydrate";
import {
  deduplicateSessionIds,
  dropGenericTitles,
  migrateWorktrees,
} from "./repair.svelte";
import * as projectWrites from "./projects.svelte";
import { bootTiming } from "./boot-timing";
import { ThreadSignals } from "./thread-signals.svelte";
import { TitleWrites } from "./title-writes";

// Shared so a project with no threads always yields the same reference, and
// frozen so a caller that tries to mutate an index array fails loudly here
// instead of silently corrupting the index.
const EMPTY_THREADS = Object.freeze([]) as unknown as Thread[];

export class AppState {
  projects = $state<Project[]>([]);
  threads = $state<Thread[]>([]);
  activeThreadId = $state<string | null>(null);
  selectedProjectId = $state<string | null>(null);
  view = $state<View>("terminal");
  // Phone layout only: which bottom-bar page is showing. Desktop ignores it.
  mobileTab = $state<MobileTab>("terminal");
  ready = $state(false);

  /**
   * What the app remembers about a thread until something consumes it, and the
   * coalescer that keeps an agent's title stream off the disk.
   *
   * Both are reached through this object rather than held here: neither has
   * anything to do with the projects, the threads or the navigation that make
   * up the rest of it, and both are worth reading on their own.
   */
  readonly signals = new ThreadSignals();
  readonly titleWrites = new TitleWrites((id) => this.threadById(id)?.origin);

  // Unsubscribe from the remote control plane; set while a remote workspace is
  // active so a switch can tear the subscription down.
  #unsubscribeControl: (() => void) | null = null;

  constructor() {
    // Path-scoped façades (git/explorer/editor/session) route through this in
    // dynamic mode: a path under a remote project's cwd goes to the boite.
    workspace.pathOriginResolver = (path) => this.originForPath(path);
  }

  // Longest-prefix match against project cwds. Local Windows paths and remote
  // Linux paths never collide; equal-length ties are irrelevant in practice.
  originForPath(path: string): WorkspaceOrigin {
    const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
    const target = norm(path);
    let best: Project | null = null;
    for (const p of this.projects) {
      const cwd = norm(p.cwd);
      if (target === cwd || target.startsWith(cwd.endsWith("/") ? cwd : cwd + "/")) {
        if (!best || cwd.length > norm(best.cwd).length) best = p;
      }
    }
    return best?.origin ?? "local";
  }

  // Kept on `app` so no caller has to know where any of this moved to. Each one
  // is the whole of what it does.
  markUnbound = (id: string) => this.signals.markUnbound(id);
  clearUnbound = (id: string) => this.signals.clearUnbound(id);
  requestActivation = (id: string) => this.signals.requestActivation(id);
  clearRequestedActivations = () => this.signals.clearRequestedActivations();
  bumpRespawn = (id: string) => this.signals.bumpRespawn(id);
  markFresh = (id: string) => this.signals.markFresh(id);
  consumeFresh = (id: string) => this.signals.consumeFresh(id);
  setPendingPrompt = (id: string, prompt: string) => this.signals.setPendingPrompt(id, prompt);
  consumePendingPrompt = (id: string) => this.signals.consumePendingPrompt(id);
  flushPendingWrites = () => this.titleWrites.flush();

  get respawnNonce(): Record<string, number> {
    return this.signals.respawnNonce;
  }

  get unboundByDedup(): string[] {
    return this.signals.unbound;
  }

  get requestedActivations(): string[] {
    return this.signals.requestedActivations;
  }

  // Rebuilt only when the thread set changes, never on a status or title
  // mutation: the callback reads id/projectId/createdAt and nothing else, so
  // the twice-a-second status sweep does not invalidate any of it.
  #threadById: Map<string, Thread> = $derived.by(
    () => new Map(this.threads.map((t) => [t.id, t])),
  );

  #projectById: Map<string, Project> = $derived.by(
    () => new Map(this.projects.map((p) => [p.id, p])),
  );

  #threadsByProject: Map<string, Thread[]> = $derived.by(() => {
    const grouped = new Map<string, Thread[]>();
    for (const t of this.threads) {
      const list = grouped.get(t.projectId);
      if (list) list.push(t);
      else grouped.set(t.projectId, [t]);
    }
    return grouped;
  });

  /**
   * What the smart-sort experiment asks for, or null while the sidebar is the
   * user's own order — which is both the toggle being off and the toggle being
   * on with `manual` still selected, so arming the experiment moves nothing.
   */
  #smartSort(): { by: "activity" | "alphabetical"; dir: 1 | -1 } | null {
    if (!settings.state.experimentSmartSort) return null;
    const by = settings.state.smartSortBy;
    if (by === "manual") return null;
    return { by, dir: settings.state.smartSortDirection === "asc" ? 1 : -1 };
  }

  /**
   * When this thread last changed what it was doing, for ranking.
   *
   * The activity registry is in-memory and knows nothing after a restart, so a
   * thread it has not seen ranks by its row's age rather than as never.
   */
  #threadActivity(thread: Thread): number {
    return threadActivitySince(thread.id) ?? thread.createdAt;
  }

  #threadsByProjectSortedIndex: Map<string, Thread[]> = $derived.by(() => {
    const orderByProject = settings.state.threadOrderByProject ?? {};
    const smart = this.#smartSort();
    const sorted = new Map<string, Thread[]>();
    for (const [projectId, list] of this.#threadsByProject) {
      // Alphabetical is about project names and says nothing about threads, so
      // only the activity order replaces the dragged one here.
      if (smart?.by === "activity") {
        sorted.set(
          projectId,
          [...list].sort(
            (a, b) =>
              (this.#threadActivity(a) - this.#threadActivity(b)) * smart.dir ||
              a.createdAt - b.createdAt,
          ),
        );
        continue;
      }
      const order = orderByProject[projectId] ?? [];
      const idx = new Map(order.map((id, i) => [id, i]));
      sorted.set(
        projectId,
        [...list].sort((a, b) => {
          const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
          const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
          if (ai !== bi) return ai - bi;
          return a.createdAt - b.createdAt;
        }),
      );
    }
    return sorted;
  });

  // Ids the index did not know about while `threads` did. Bounded, because it
  // grows on a failure that repeats: without a cap a stuck index would add one
  // entry per lookup, forever.
  #indexMisses = new Set<string>();

  /**
   * Says so when the index disagrees with the list it is built from.
   *
   * Once per id: the status engine asks about every thread twice a second, and
   * a miss that survives would otherwise write a line at that rate.
   */
  private noteIndexMiss(id: string) {
    if (this.#indexMisses.has(id)) return;
    if (this.#indexMisses.size > 200) this.#indexMisses.clear();
    this.#indexMisses.add(id);
    logger.warn("app", `${id}: the thread index missed a row the list holds`, {
      threads: this.threads.length,
      indexed: this.#threadById.size,
    });
  }

  /**
   * Every lookup used to be a linear scan, and the status engine does one per
   * thread twice a second — quadratic in the number of open threads.
   *
   * Falls back to that scan when the index misses, because the index is a
   * `$derived` and everything here treats a null as "this thread does not
   * exist". An index one beat behind the list therefore did not slow anything
   * down, it made the app deny threads that were right there: the pane stayed
   * empty (activation is gated on `hasThread`), closing refused (`closeThread`
   * returns early on a null), and only a restart — which rebuilds the index —
   * gave them back. The scan costs a pass over the list on a miss, and a miss
   * is either that bug or an id that is genuinely gone.
   */
  threadById(id: string | null | undefined): Thread | null {
    if (!id) return null;
    const hit = this.#threadById.get(id);
    if (hit) return hit;
    const scanned = this.threads.find((t) => t.id === id) ?? null;
    if (scanned) this.noteIndexMiss(id);
    return scanned;
  }

  hasThread(id: string): boolean {
    return this.threadById(id) !== null;
  }

  /** Indexed for the same reason as `threadById`: the status sweep resolves a
   * thread's directory through its project, twice a second, for every thread. */
  projectById(id: string | null | undefined): Project | null {
    if (!id) return null;
    return this.#projectById.get(id) ?? null;
  }

  get activeThread(): Thread | null {
    return this.threadById(this.activeThreadId);
  }

  /**
   * The project a launch would land in, or null when the user is on none.
   *
   * No fallback to the first row: "on no project" stays a state this can
   * report. Boot picks the first project once (see `init`), so it is now
   * reached only by having no projects at all. The sidebar's empty space used
   * to be the other way in, and it cost more than it bought: a click on
   * nothing closed the open thread, and Scratch is a row in that list anyway.
   */
  get currentProjectId(): string | null {
    if (this.selectedProjectId) return this.selectedProjectId;
    return this.activeThread?.projectId ?? null;
  }

  // Both of these return the index's own arrays. Callers iterate and map, they
  // never mutate — a fresh copy per call would defeat the reference equality
  // consumers rely on to skip work.
  threadsByProject(projectId: string): Thread[] {
    return this.#threadsByProject.get(projectId) ?? EMPTY_THREADS;
  }

  threadsByProjectSorted(projectId: string): Thread[] {
    return this.#threadsByProjectSortedIndex.get(projectId) ?? EMPTY_THREADS;
  }

  // $derived (not getters): several components read these per render pass;
  // getters would rebuild the Map + sort on every access.
  /**
   * A boite project this device has not asked for.
   *
   * Dynamic mode loads every remote row, because the picker that ticks them has
   * to list what is there. Which of them reach the sidebar is a per-device
   * choice, and it is applied here rather than at load time so unticking one is
   * instant instead of a round trip to the boite.
   */
  #hiddenRemote(project: Project): boolean {
    if (!workspace.isDynamic || project.origin !== "remote") return false;
    return !device.isRemoteProjectShown(workspace.activeBoiteId, project.id);
  }

  sortedProjects: Project[] = $derived.by(() => {
    const order = settings.state.projectOrder ?? [];
    const idx = new Map(order.map((id, i) => [id, i]));
    const smart = this.#smartSort();
    // A project ranks by its most recently active thread. Zero for a project
    // with none, which parks the empty ones together at the quiet end.
    const activityOf = (p: Project): number => {
      const threads = this.#threadsByProject.get(p.id);
      if (!threads || threads.length === 0) return 0;
      return Math.max(...threads.map((t) => this.#threadActivity(t)));
    };
    return this.projects
      .filter((p) => !p.archived && !this.#hiddenRemote(p))
      // Scratch stays listed even with nothing in it. It was hidden while empty,
      // on the reading that a door nobody has walked through is not a project
      // the user has — but the launcher hangs off a card's own `+`, so hiding
      // the card removed the only way to start a thread with no project at all,
      // and the door was shut from the outside.
      .sort((a, b) => {
        // Scratch sits last whatever any order says. It is where work starts,
        // not one of the things being worked on, and drifting into the middle
        // of the real projects is the one place it does not belong.
        const as = a.id === SCRATCH_PROJECT_ID ? 1 : 0;
        const bs = b.id === SCRATCH_PROJECT_ID ? 1 : 0;
        if (as !== bs) return as - bs;
        if (smart) {
          const cmp =
            smart.by === "activity"
              ? (activityOf(a) - activityOf(b)) * smart.dir
              : a.name.localeCompare(b.name) * smart.dir;
          if (cmp !== 0) return cmp;
          return a.name.localeCompare(b.name);
        }
        const ai = idx.get(a.id) ?? Number.MAX_SAFE_INTEGER;
        const bi = idx.get(b.id) ?? Number.MAX_SAFE_INTEGER;
        if (ai !== bi) return ai - bi;
        return a.name.localeCompare(b.name);
      });
  });

  archivedProjects: Project[] = $derived.by(() => {
    return this.projects
      .filter((p) => p.archived && !this.#hiddenRemote(p))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  async init() {
    if (this.ready) return;
    bootTiming.start();

    // Rows depend on neither the settings blob nor the shell list, so all of
    // it goes out at once: boot is then two round trips deep (loads, then
    // syncRoots) instead of three.
    const rowsReady = loadRows();
    await Promise.all([settings.init(), platform.init()]);

    if (settings.state.defaultShellId === null && platform.shells.length > 0) {
      // The order belongs to the OS that produced the list. A host that never
      // answered gets no order at all rather than the POSIX one, which used to
      // be applied to a Windows shell list whenever the probe had failed.
      const preferred = !platform.hostKnown
        ? []
        : platform.isHostWindows
          ? ["pwsh", "powershell", "git-bash", "cmd"]
          : ["zsh", "bash", "fish", "sh"];
      const pick =
        preferred
          .map((id) => platform.shells.find((s) => s.id === id))
          .find((s) => s != null) ?? platform.shells[0];
      if (pick) await settings.setDefaultShellIdQuiet(pick.id);
    }

    // Kick the function/alias probe now, while the rest of boot is still
    // running: by the time a shortcut is clicked the answer is already there,
    // and a shortcut clicked sooner than that costs nothing, it just falls
    // back to the PATH for that one spawn. A failure here is not worth a toast.
    if (settings.state.defaultShellId) {
      void backend()
        .shell.warmShell(settings.state.defaultShellId)
        .catch(() => {});
    }

    bootTiming.mark("settings+platform");

    const { projects, threads } = await rowsReady;
    bootTiming.mark("rows");
    this.projects = projects;
    // Before anything reads sortedProjects: a device coming from the era when
    // dynamic mode grafted every remote project keeps seeing all of them, and
    // unticks the ones it does not want from the picker like everyone else.
    if (
      workspace.isDynamic &&
      workspace.activeBoiteId &&
      device.needsRemoteProjectSeed
    ) {
      device.seedRemoteProjects(
        workspace.activeBoiteId,
        projects.filter((p) => p.origin === "remote").map((p) => p.id),
      );
    }
    // Boot lands on Scratch's own page rather than on the first project's
    // terminals. It is the one place in the app that starts something without
    // committing to a project, which is what opening the app usually is; the
    // previous landing was whatever project happened to sort first, showing its
    // panels and its threads to somebody who had not asked for either.
    //
    // The row is seeded here rather than left to `ensureScratch`'s first caller
    // because both the page and the sidebar card need one to draw, and that card
    // is the only `+` a user with no project has.
    if (this.selectedProjectId === null) {
      const scratch = await projectWrites.ensureScratch(this);
      this.selectedProjectId = scratch?.id ?? this.sortedProjects[0]?.id ?? null;
      if (scratch) this.view = "project";
    }
    // Before ready: panels start polling fs/git commands as soon as they
    // mount, and those commands reject paths outside registered roots.
    await syncRoots(this);
    bootTiming.mark("roots");
    this.threads = threads;

    deduplicateSessionIds(this);
    dropGenericTitles(this);
    pruneRenamed(this.threads.map((t) => t.id));
    await migrateWorktrees(this);
    bootTiming.mark("repair");

    // Remote: the server is authoritative for thread runtime state and pushes
    // it as control events. Local has no subscribe and derives status itself.
    // Dynamic subscribes on the boite connection (current() is local there).
    const be = workspace.isDynamic ? workspace.remoteBackend : backend();
    if (be?.subscribe) {
      this.#unsubscribeControl = be.subscribe((ev) => applyControlEvent(this, ev));
    }

    this.ready = true;
    // Last, so the line covers everything a user waited through rather than
    // everything up to the phase somebody remembered to mark.
    bootTiming.report();
  }

  /**
   * Add a boite's half to a workspace that is already running.
   *
   * The dynamic graft used to happen inside `init()`, which meant boot waited on
   * the dial: a boite that was off bought twelve seconds of an app with no
   * projects and no threads in it, and an app with nothing in it reads as a
   * machine that lost everything rather than as a boite that is down. So the
   * local side boots on its own and the remote rows land here, whenever they
   * land.
   *
   * Nothing local is touched: `resyncFromServer` replaces the remote half and
   * leaves the local rows, their runtime state and the current selection exactly
   * as they are.
   */
  async attachRemote() {
    const remote = workspace.remoteBackend;
    if (!remote || !this.ready) return;
    await resyncFromServer(this);
    if (workspace.activeBoiteId && device.needsRemoteProjectSeed) {
      device.seedRemoteProjects(
        workspace.activeBoiteId,
        this.projects.filter((p) => p.origin === "remote").map((p) => p.id),
      );
    }
    // The boite is authoritative for its threads' runtime state and pushes it as
    // control events; local derives its own. Re-subscribing is safe because a
    // local-only boot left no subscription behind.
    this.#unsubscribeControl?.();
    this.#unsubscribeControl = remote.subscribe((ev) => applyControlEvent(this, ev));
  }

  // Clear reactive state so a workspace switch re-hydrates from the new
  // backend instead of mixing two workspaces' projects/threads.
  reset() {
    this.#unsubscribeControl?.();
    this.#unsubscribeControl = null;
    this.titleWrites.discard();
    this.signals.reset();
    resetFinished();
    this.projects = [];
    this.threads = [];
    this.activeThreadId = null;
    this.selectedProjectId = null;
    this.view = "terminal";
    this.mobileTab = "terminal";
    this.ready = false;
    // A workspace switch is another boot and gets its own measurement. Keeping
    // the old one would report the switch as having taken since app start.
    bootTiming.restart();
  }

  /**
   * Puts the thread in the store now, and persists it behind the caller.
   *
   * Not async on purpose: the store write has to happen at call time, in the
   * click's own task, while the returned promise is only the row reaching
   * SQLite. A launch does not await it — the sidebar entry and the terminal are
   * what the user clicked for, and an IPC round trip plus a WAL commit in front
   * of them is a wait for nothing. A caller that has to know the row landed
   * (a move, which reports failure and gives up) still awaits.
   *
   * Rejects rather than swallowing: callers show a "Failed to create thread"
   * toast. Swallowing here left the thread memory-only, silently vanishing on
   * restart.
   */
  upsertThread(thread: Thread): Promise<void> {
    const i = this.threads.findIndex((t) => t.id === thread.id);
    if (i >= 0) this.threads[i] = thread;
    else this.threads.push(thread);
    return saveThread(thread);
  }

  /**
   * Where the window goes once the terminal it was showing is gone.
   *
   * It used to go nowhere: the active thread was cleared and the view stayed on
   * the terminal, so whatever pane the project happened to have open took the
   * whole screen — closing the last thread of a project with the git panel
   * docked left the user staring at a full-window diff nobody asked for.
   *
   * A sibling still running wins, because that is a terminal to look at. With
   * none, the project's own page is the answer, and with no project at all it is
   * Scratch, which is the same place boot lands on.
   *
   * Only from the terminal view. A thread closed from the palette while the
   * editor or the settings are up is not a reason to throw away what the user
   * was reading.
   */
  private fallBackFromClosed(removed: Thread | null) {
    const projectId = removed?.projectId ?? this.selectedProjectId;
    const project = this.projectById(projectId);
    if (project) {
      this.selectedProjectId = project.id;
      const sibling = this.threadsByProjectSorted(project.id).find((t) => t.ptyId);
      if (sibling) {
        this.activeThreadId = sibling.id;
        return;
      }
      if (this.view === "terminal") this.view = "project";
      return;
    }
    if (this.view !== "terminal") return;
    void projectWrites.ensureScratch(this).then((scratch) => {
      if (!scratch || this.activeThreadId !== null) return;
      this.selectedProjectId = scratch.id;
      if (this.view === "terminal") this.view = "project";
    });
  }

  async removeThread(id: string) {
    const removed = this.threadById(id);
    this.threads = this.threads.filter((t) => t.id !== id);
    if (this.activeThreadId === id) {
      this.activeThreadId = null;
      this.fallBackFromClosed(removed);
    }
    clearRenamed(id);
    forgetThreadActivity(id);
    try {
      await dbDeleteThread(id, removed?.origin);
    } catch (err) {
      logger.error("app", "deleteThread failed", err);
      notifications.error(t("app.closeThreadFailed"));
    }
  }

  setThreadStatus(id: string, status: ThreadStatus, exitCode: number | null = null) {
    const t = this.threadById(id);
    if (!t) return;
    if (t.status === status && t.exitCode === exitCode) return;
    noteStatusChange(id, t.status, status);
    t.status = status;
    t.exitCode = exitCode;
    if (status !== "stopped" && t.autoSlept) {
      // Drop the sleep badge as soon as the thread leaves "stopped". The flag
      // is in-memory only (see setThreadAutoSlept), so this clear — not any
      // write — is the whole reason a woken thread stops animating.
      this.setThreadAutoSlept(id, false);
    }
    // Nothing is written here, and that is the change. A status is a statement
    // about a process, and every one of them stops being true when the app
    // closes; what the row keeps is that there *was* a run, written once by
    // `setThreadPtyId`. The five writes this used to make per turn also went
    // nowhere: `thread.create` keeps the persisted status by design, so a
    // whole-row save could never carry one.
  }

  setThreadAutoSlept(id: string, value: boolean) {
    const t = this.threadById(id);
    if (!t || (t.autoSlept ?? false) === value) return;
    t.autoSlept = value;
    // Visual-only flag, never persisted. After a restart all threads come
    // back without the zZ animation; clicking re-spawns them like any
    // other stopped thread.
  }

  setThreadKeepAwake(id: string, value: boolean) {
    const t = this.threadById(id);
    if (!t || (t.keepAwake ?? false) === value) return;
    t.keepAwake = value;
    void saveThread($state.snapshot(t) as Thread);
  }

  toggleThreadKeepAwake(id: string) {
    const t = this.threadById(id);
    if (!t) return;
    this.setThreadKeepAwake(id, !(t.keepAwake ?? false));
  }

  setThreadTitle(id: string, title: string) {
    // Named by hand: the agent's own titles stop applying to this thread.
    if (isRenamed(id)) return;
    const t = this.threadById(id);
    if (!t || t.title === title) return;
    t.title = title;
    // Remote owns the title (parsed server-side, pushed as a control event).
    if (!workspace.backendFor(t.origin).caps.clientStatus) return;
    this.titleWrites.queue(id, title);
  }

  // Manual rename. Unlike setThreadTitle this persists on every backend: the
  // remote server only writes back titles it parsed itself, so a name typed
  // here would never reach its row. Passing null drops the manual name — the
  // thread falls back to its label and the agent gets to title it again.
  async renameThread(id: string, name: string | null) {
    // Named `thread`, not `t`: this file uses `t` for a thread almost everywhere,
    // and here that shadows the translation helper.
    const thread = this.threadById(id);
    if (!thread) return;
    const title = name?.trim() || null;
    thread.title = title;
    // An OSC title queued just before the rename would land on top of it.
    this.titleWrites.cancel(id);
    if (title) markRenamed(id);
    else clearRenamed(id);
    try {
      await updateThreadTitle(id, title, thread.origin);
    } catch (err) {
      logger.error("app", "renameThread failed", err);
      notifications.error(t("app.renameThreadFailed"));
    }
  }

  setThreadPtyId(id: string, ptyId: string | null) {
    const t = this.threadById(id);
    if (!t || t.ptyId === ptyId) return;
    t.ptyId = ptyId;
    if (!ptyId) return;
    // The one thing about a run that outlives it. A row with this mark comes
    // back from a restart drawn as a thread that was cut off; a row without it
    // draws nothing at all, which is what a thread nobody has started looks
    // like. Remote rows are the server's to mark: it watches the PTYs it owns.
    if (!workspace.backendFor(t.origin).caps.clientStatus) return;
    void markThreadStarted(id, t.origin).catch((err) => {
      logger.warn("app", `could not mark thread ${id} as started`, String(err));
    });
  }

  // ------------------------------------------------------------- projects
  //
  // The bodies live in `projects.svelte.ts`. They stay reachable here because
  // every caller in the app says `app.renameProject(...)`, and a decomposition
  // that makes forty components import a second module is a decomposition
  // nobody keeps.

  updateProject = (project: Project) => projectWrites.updateProject(this, project);
  renameProject = (id: string, name: string) => projectWrites.renameProject(this, id, name);
  setProjectWorktrees = (id: string, enabled: boolean) =>
    projectWrites.setProjectWorktrees(this, id, enabled);
  ensureScratch = () => projectWrites.ensureScratch(this);
  addProject = (project: Project) => projectWrites.addProject(this, project);
  archiveProject = (id: string) => projectWrites.archiveProject(this, id);
  unarchiveProject = (id: string) => projectWrites.unarchiveProject(this, id);
  removeProject = (id: string) => projectWrites.removeProject(this, id);
}

export const app = new AppState();
