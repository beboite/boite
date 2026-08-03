import type { Project, Thread, WorkspaceOrigin } from "$lib/types";
import { loadProjects, loadThreads } from "$lib/storage/db";
import { registerProjectRoots } from "$lib/storage/scope";
import { logger } from "$lib/shared/services/logger.svelte";
import { workspace, type Backend } from "$lib/backend";
import type { AppState } from "./store.svelte";

/**
 * Reading a workspace into the store, and reading it again when it drifts.
 *
 * Four ways in and one shape out. Boot loads both tables, a control event says
 * the projects changed, a resync says the client and the server have diverged,
 * and every one of them ends with the same two arrays assigned. They were four
 * bodies inside the store doing that, and the store is where they were hardest
 * to compare.
 *
 * Free functions over an `AppState` rather than methods, and none of them
 * imports the `app` singleton: the store owns the reactive fields and reaches
 * for these, never the other way round.
 *
 * **The rule every function here obeys.** In dynamic mode the local rows and the
 * boite's rows live in the same two arrays, told apart by `origin`. So a refresh
 * of the remote half replaces the remote half and leaves the local rows exactly
 * as they are, runtime state included. Reassigning the whole array from one side
 * is how a local terminal loses its `ptyId` because a server said something
 * about a project.
 */

/** Both tables, concurrently, degrading to what could be read. */
export async function loadRows(): Promise<{ projects: Project[]; threads: Thread[] }> {
  if (workspace.isDynamic) {
    const [projects, threads] = await Promise.all([
      loadDynamic((be) => be.db.loadProjects(), "loadProjects"),
      loadDynamic((be) => be.db.loadThreads(), "loadThreads"),
    ]);
    return { projects, threads };
  }
  const [projects, threads] = await Promise.all([
    loadProjects().catch((err) => {
      logger.error("app", "loadProjects failed", err);
      return [] as Project[];
    }),
    loadThreads().catch((err) => {
      logger.error("app", "loadThreads failed", err);
      return [] as Thread[];
    }),
  ]);
  return { projects, threads };
}

/**
 * One table from both live backends, each row tagged with where it came from.
 *
 * A remote failure degrades to local-only rather than blocking boot: a boite
 * that is down should cost the user the boite, not the app.
 */
async function loadDynamic<T extends { origin?: WorkspaceOrigin }>(
  load: (be: Backend) => Promise<T[]>,
  label: string,
): Promise<T[]> {
  const localP = load(workspace.backendFor("local")).catch((err) => {
    logger.error("app", `${label} (local) failed`, err);
    return [] as T[];
  });
  const remote = workspace.remoteBackend;
  const remoteP = remote
    ? load(remote).catch((err) => {
        logger.error("app", `${label} (remote) failed`, err);
        return [] as T[];
      })
    : Promise.resolve([] as T[]);
  const [localRows, remoteRows] = await Promise.all([localP, remoteP]);
  return [
    ...localRows.map((r) => ({ ...r, origin: "local" as const })),
    ...remoteRows.map((r) => ({ ...r, origin: "remote" as const })),
  ];
}

/**
 * Tells the backend which folders it may touch.
 *
 * Local paths only. Tauri's filesystem trust boundary is about this machine,
 * and the server derives its own from the projects it persists; in dynamic mode
 * the remote cwds are Linux paths that would only pollute the local scope.
 */
export async function syncRoots(app: AppState) {
  try {
    const roots = app.projects
      .filter((p) => (p.origin ?? "local") === "local")
      .map((p) => p.cwd);
    await registerProjectRoots(roots);
  } catch (err) {
    logger.error("app", "registerProjectRoots failed", err);
  }
}

/** The projects again, after the server said they changed. */
export async function refreshRemoteProjects(app: AppState) {
  if (workspace.isDynamic) {
    const remote = workspace.remoteBackend;
    if (!remote) return;
    const p = await remote.db.loadProjects();
    app.projects = [
      ...app.projects.filter((x) => x.origin !== "remote"),
      ...p.map((x) => ({ ...x, origin: "remote" as const })),
    ];
  } else {
    app.projects = await loadProjects();
  }
}

/**
 * Both tables again, after the server said it lost track of what we missed.
 *
 * A failure here is written down and nothing else: the client keeps the rows it
 * has, which are stale rather than wrong, and the next event or the next boot
 * settles it. Throwing would take down whatever was watching the socket.
 */
export async function resyncFromServer(app: AppState) {
  try {
    if (workspace.isDynamic) {
      const remote = workspace.remoteBackend;
      if (!remote) return;
      const [projects, threads] = await Promise.all([
        remote.db.loadProjects(),
        remote.db.loadThreads(),
      ]);
      app.projects = [
        ...app.projects.filter((x) => x.origin !== "remote"),
        ...projects.map((x) => ({ ...x, origin: "remote" as const })),
      ];
      app.threads = [
        ...app.threads.filter((x) => x.origin !== "remote"),
        ...threads.map((x) => ({ ...x, origin: "remote" as const })),
      ];
    } else {
      const [projects, threads] = await Promise.all([loadProjects(), loadThreads()]);
      app.projects = projects;
      app.threads = threads;
    }
  } catch (err) {
    logger.error("app", "resync failed", err);
  }
}
