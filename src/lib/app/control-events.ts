import type { Thread } from "$lib/types";
import type { ControlEvent } from "$lib/backend/types";
import { logger } from "$lib/shared/services/logger.svelte";
import { workspace } from "$lib/backend";
import { device } from "$lib/features/settings/device.svelte";
import { isFinished } from "$lib/domain/thread-status";
import { isRenamed } from "$lib/features/thread/renamed";
import { noteStatusChange } from "$lib/features/thread/finished.svelte";
import { announceStatus } from "$lib/features/thread/statusEngine";
import { todos } from "$lib/features/todo/store.svelte";
import { approvals } from "$lib/features/approvals/store.svelte";
import { refreshRemoteProjects, resyncFromServer } from "./hydrate";
import type { AppState } from "./store.svelte";

/**
 * What a boite pushes, projected onto this client's rows.
 *
 * Remote only. The server owns thread runtime state there, so this is the one
 * place a status, a title or a row arrives from outside and the client's job is
 * to project it rather than to decide anything.
 *
 * **Why the remote path does not go through the store's setters.** They persist,
 * and persisting here would write the client's copy back over the state the
 * server owns. The cost of that is one thing having to be remembered twice, and
 * it has already been forgotten once: `noteStatusChange` lives in `setThreadStatus`
 * for the local path and has to be repeated here, or a boite's threads would
 * never glow when they finish.
 */
export function applyControlEvent(app: AppState, ev: ControlEvent, envId?: string) {
  const data = ev.data as Record<string, unknown> | null;
  // With several boites pushing at once, a bare `thread.status` names a row id
  // that exists on more than one of them. The rows in `app` belong to the
  // active workspace alone, so an event from any other environment is patched
  // into that environment's own projection (`EnvironmentRuntime`) and must not
  // reach here — except for the one thing that is not about rows.
  if (envId && envId !== "remote" && envId !== workspace.activeBoiteId) {
    if (ev.event === "workspace.info") {
      device.updateBoite(envId, {
        name: typeof data?.name === "string" ? data.name : "",
        color: typeof data?.color === "string" ? data.color : "",
      });
    }
    return;
  }
  switch (ev.event) {
    case "thread.status": {
      const id = data?.threadId as string | undefined;
      const thread = app.threadById(id);
      if (!thread) return;
      const incomingStatus = (data?.status as Thread["status"]) ?? thread.status;
      noteStatusChange(thread.id, thread.status, incomingStatus);
      // The other half of the same repetition. `statusEngine` skips every
      // thread whose backend owns its own status, so the two notifications it
      // raises were unreachable for a boite's threads: a desktop connected to
      // one got no toast when an agent finished or put a dialog up, and it has
      // no web push either. Called with the pushed status rather than the
      // stored one, and it keeps its own record of what each thread last read,
      // so the first event about a thread is a reading and says nothing.
      announceStatus(thread, incomingStatus);
      thread.status = incomingStatus;
      thread.exitCode = (data?.exitCode as number | null) ?? null;
      // Four statuses, not three. `stopped` used to be missing here and nowhere
      // else, so a thread the server had put to sleep kept a ptyId pointing at a
      // process it had already reaped, and `visibleStatus` then drew it as
      // ready. `stopThread` clears the id on the local path for the same reason.
      if (isFinished(thread.status)) {
        thread.ptyId = null;
      }
      break;
    }
    case "thread.title": {
      const id = data?.threadId as string | undefined;
      const thread = app.threadById(id);
      // A user-typed name outranks whatever the server parsed out of the PTY.
      if (thread && !isRenamed(thread.id)) thread.title = (data?.title as string) ?? thread.title;
      break;
    }
    case "thread.created": {
      const incoming = (ev.data as { thread?: Thread })?.thread;
      if (incoming?.id && !app.hasThread(incoming.id)) {
        if (workspace.isDynamic) incoming.origin = "remote";
        app.threads.push(incoming);
      }
      break;
    }
    case "thread.updated": {
      // Merge user-owned fields only. Runtime fields are driven by
      // `thread.status` and the live overlay, and an update that carried them
      // would undo whatever the terminal is doing right now.
      const incoming = (ev.data as { thread?: Partial<Thread> & { id?: string } })?.thread;
      const thread = app.threadById(incoming?.id);
      if (thread && incoming) {
        const userFields: Record<string, unknown> = { ...incoming };
        delete userFields.status;
        delete userFields.ptyId;
        delete userFields.exitCode;
        delete userFields.origin;
        if (isRenamed(thread.id)) delete userFields.title;
        Object.assign(thread, userFields);
      }
      break;
    }
    case "thread.deleted": {
      const id = data?.threadId as string | undefined;
      if (id) app.threads = app.threads.filter((x) => x.id !== id);
      break;
    }
    case "project.changed": {
      void refreshRemoteProjects(app).catch(() => {});
      break;
    }
    // The writer may be an agent on the server rather than a client, so the
    // event carries no row: reload instead of patching one in.
    case "todos.changed": {
      void todos.reload().catch(() => {});
      break;
    }
    // Same shape, and the same reason it cannot carry the row: a request is
    // opened by an agent talking to the server, not by anything this client did.
    case "approvals.changed": {
      void approvals.reload().catch(() => {});
      break;
    }
    // Another device renamed or recoloured this boite. Cosmetic: update the live
    // identity and the cached label on the device registry.
    case "workspace.info": {
      const name = typeof data?.name === "string" ? data.name : null;
      const color = typeof data?.color === "string" ? data.color : null;
      // The event carries the cosmetic pair only, so the version stays what the
      // last read said: a rename on another device is not a redeploy.
      workspace.info = { name, color, version: workspace.info.version };
      if (workspace.activeBoiteId) {
        device.updateBoite(workspace.activeBoiteId, {
          name: name ?? "",
          color: color ?? "",
        });
      }
      break;
    }
    // An agent on the boite asked to be moved, or for a project, or for a second
    // terminal. It reaches every connected device because the server cannot tell
    // which one is watching; the handler claims it first so only one device acts.
    // Imported late: the handler pulls in the thread and project APIs, which
    // import the store this is called from.
    case "agent.request": {
      void import("./agent-requests")
        .then((m) => m.handleRemoteAgentRequest(ev.data))
        .catch((err) => logger.error("app", "agent.request failed", err));
      break;
    }
    // The orchestrator log grew, or an orchestrator was armed. The store pulls
    // from its cursor, so a burst of moments costs one cheap fetch, not a
    // re-read. Imported late for the same reason agent-requests is.
    case "moment.appended":
    case "orchestrator.changed": {
      void import("$lib/features/orchestrator/store.svelte")
        .then((m) => m.orchestrator.onWorkspaceEvent())
        .catch(() => {});
      break;
    }
    // A line was queued for a thread whose PTY may be this device's; the
    // dispatch module drains and decides. Dismissed is the boite putting a
    // row away, mirrored locally. Imported late like agent-requests: the
    // module pulls in the store this is called from.
    case "dispatch.queued": {
      void import("./dispatches")
        .then((m) => m.flushDispatches())
        .catch((err) => logger.error("app", "dispatch.queued failed", err));
      break;
    }
    case "thread.dismissed": {
      const id = data?.threadId as string | undefined;
      if (id)
        void import("./dispatches")
          .then((m) => m.onThreadDismissed(id))
          .catch(() => {});
      break;
    }
    // The server lost track of which control events we missed (broadcast lag);
    // refetch the durable lists so the two do not diverge silently.
    case "resync": {
      void resyncFromServer(app);
      break;
    }
  }
}
