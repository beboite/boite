/**
 * What an agent driving this app cannot otherwise see.
 *
 * Boite is developed through the `mcp-bridge` plugin, which gives an agent a
 * screenshot and a way to run JavaScript in the webview. Neither reaches the
 * parts of this app that matter most when checking whether a change worked:
 *
 * - The terminals render to a WebGL canvas. Every agent Boite runs writes its
 *   entire output there, and to the DOM it is a blank element. Reading a
 *   screenshot back is not a substitute — text in a picture cannot be grepped,
 *   and the interesting line has usually scrolled off it.
 * - Toasts say what went wrong and then disappear, usually before a screenshot
 *   is taken.
 * - Thread state — which project, which folder, which session, which worktree —
 *   is the whole subject of half the features here, and the sidebar shows a
 *   label and a coloured dot.
 *
 * So this puts them on `window.__boite`, as plain JSON-serialisable values that
 * `webview_execute_js` can return directly.
 *
 * Development builds only: `import.meta.env.DEV` is `false` in `vite build`, so
 * the installer returns before it touches `window` and a release build has no
 * `__boite` on it. Whether the rest of the module survives into the bundle is
 * the minifier's business; nothing in it can run either way.
 *
 * Read-only, deliberately. A debugging aid that can change state is a second
 * way to drive the app, and nothing tests that one.
 */

import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";
import { notifications, raisedToasts } from "$lib/features/notifications/store.svelte";
import { paneStore } from "$lib/features/panes/store.svelte";
import { threadCwd, threadGitRoot } from "$lib/features/thread/cwd";
import {
  liveTerminal,
  liveTerminalIds,
  terminalText,
} from "$lib/features/terminal/live";
import type { Thread } from "$lib/types";

/** One thread, with the fields that decide what it is and where it runs. */
function describeThread(t: Thread) {
  const project = app.projects.find((p) => p.id === t.projectId) ?? null;
  return {
    id: t.id,
    label: t.label,
    title: t.title,
    project: project?.name ?? null,
    projectId: t.projectId,
    agent: t.iconKey,
    status: t.status,
    exitCode: t.exitCode,
    running: !!t.ptyId,
    cwd: threadCwd(t, project),
    gitRoot: threadGitRoot(t, project),
    worktree: t.worktreePath ?? null,
    sessionId: t.sessionId,
    cmd: [t.cmd, ...t.args].join(" "),
    hasTerminal: liveTerminalIds().includes(t.id),
    origin: t.origin ?? "local",
  };
}

/**
 * A thread by id, by label, or by title — whichever the caller has.
 *
 * Ids are uuids nobody reads off a screenshot, so a name has to work. An
 * ambiguous name is refused rather than resolved to the first match: reading
 * the wrong terminal answers the question confidently and wrongly, which is the
 * one outcome a debugging tool must not produce.
 */
function findThread(needle: string): Thread | { error: string } {
  const byId = app.threadById(needle);
  if (byId) return byId;
  const target = needle.trim().toLowerCase();
  const matches = app.threads.filter(
    (t) =>
      t.label.toLowerCase() === target ||
      (t.title ?? "").toLowerCase() === target,
  );
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    return {
      error: `"${needle}" names ${matches.length} threads: ${matches
        .map((t) => t.id)
        .join(", ")}`,
    };
  }
  return {
    error: `no thread called "${needle}". __boite.threads() lists them.`,
  };
}

const inspector = {
  /** Everything at once, for the first look. */
  overview() {
    return {
      ready: app.ready,
      view: app.view,
      workspace: workspace.mode,
      activeThread: app.activeThread
        ? { id: app.activeThread.id, label: app.activeThread.label }
        : null,
      selectedProject: app.selectedProjectId,
      projects: app.projects.length,
      threads: app.threads.length,
      running: app.threads.filter((t) => t.ptyId).length,
      toasts: notifications.toasts.length,
    };
  },

  threads(projectName?: string) {
    const rows = app.threads.map(describeThread);
    if (!projectName) return rows;
    const target = projectName.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (r.project ?? "").toLowerCase() === target || r.projectId === projectName,
    );
  },

  thread(needle: string) {
    const found = findThread(needle);
    return "error" in found ? found : describeThread(found);
  },

  projects() {
    return app.projects.map((p) => ({
      id: p.id,
      name: p.name,
      cwd: p.cwd,
      gitRoot: p.gitRoot ?? null,
      archived: p.archived,
      origin: p.origin ?? "local",
      threads: app.threadsByProject(p.id).length,
    }));
  },

  /**
   * What a terminal is showing, as text. The reason this module exists.
   *
   * `tail` counts from the bottom, because the answer to "did it work" is at
   * the bottom and a busy agent's scrollback is thousands of lines.
   */
  read(needle: string, tail = 200) {
    const found = findThread(needle);
    if ("error" in found) return found;
    const term = liveTerminal(found.id);
    if (!term) {
      return {
        error: `${found.label} has no terminal mounted. Threads only mount when their pane is opened; click it first.`,
      };
    }
    return { thread: found.label, text: terminalText(term, tail) };
  },

  /** Which threads can be read right now. */
  mounted() {
    return liveTerminalIds().map((id) => ({
      id,
      label: app.threadById(id)?.label ?? "?",
    }));
  },

  /**
   * Every toast raised this session, not only the ones still on screen.
   *
   * A toast is how this app reports a failure and it dismisses itself after a
   * few seconds, so reading only the live ones answers "nothing went wrong" to
   * a question asked four seconds too late.
   */
  toasts(tail = 20) {
    const showing = new Set(notifications.toasts.map((t) => t.message));
    return raisedToasts()
      .slice(-tail)
      .map((t) => ({ ...t, showing: showing.has(t.message) }));
  },

  /** How the panes are split, which no screenshot explains. */
  panes() {
    return paneStore.groups.map((g) => ({
      id: g.id,
      focused: g.focusedThreadId,
      threads: app.threads
        .filter((t) => paneStore.groupOf(t.id)?.id === g.id)
        .map((t) => t.label),
    }));
  },

  settings() {
    // Round-tripped rather than snapshotted: this is a plain `.ts` module, so
    // `$state.snapshot` is not compiled here and would be undefined at runtime.
    // JSON is also exactly the shape the caller gets back over the bridge, so
    // anything that does not survive it was never readable there anyway.
    return JSON.parse(JSON.stringify(settings.state));
  },
};

export type BoiteInspector = typeof inspector;

/**
 * Puts the inspector on `window.__boite`, in development builds only.
 *
 * Called from the root layout rather than at import time so it happens once,
 * after the stores exist, and so a module-graph change cannot quietly stop it
 * happening at all.
 */
export function installInspector() {
  if (!import.meta.env.DEV || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__boite = inspector;
  console.info(
    "[boite] dev inspector on window.__boite —",
    Object.keys(inspector).join(", "),
  );
}
