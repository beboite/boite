import { app } from "$lib/app/store.svelte";
import { resolveLaunch } from "$lib/app/agent-requests";
import { backend } from "$lib/backend/active.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { launchAgent, reloadThread } from "$lib/features/thread/api";
import { typeIntoOrchestrator } from "$lib/app/dispatches";
import { withUnattendedArgs } from "$lib/features/thread/session";
import { pilotCatalog } from "$lib/features/pilot/catalog.svelte";
import { chatAvailable, chatLaunchForArgv, type ChatLaunch } from "$lib/features/pilot/launch";
import { openPilotSession } from "$lib/features/pilot/session";
import { logger } from "$lib/shared/services/logger.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
import type { PilotCatalog } from "$lib/features/pilot/types";
import type { Thread } from "$lib/types";

/**
 * Lazy start, end to end. Nothing runs at boot; the first message is what
 * calls `orchestrator.start`, and this file is that path.
 *
 * The ordering that matters: the role stamp has to be on the row before the
 * Terminal mounts, because mounting is what spawns the PTY and the spawn reads
 * the row to hand the process its `BOITE_ROLE` hint. So the thread is created
 * with `deferActivation`, the row's INSERT is awaited, `orchestrator.start`
 * lands, and only then does the activation queue get the thread.
 */

/**
 * Whether this orchestrator would be a chat thread, and what it would run on.
 *
 * A pure function so the branch is testable without a window: the two
 * experiments arm it at all, the argv names a driver, and the catalog decides
 * whether this build talks to that driver over its own protocol. `null` is the
 * terminal orchestrator, unchanged, which is what an agent with no driver and a
 * boite with the experiment off both get.
 */
export function orchestratorChatLaunch(input: {
  cmd: string;
  args: readonly string[];
  catalog: PilotCatalog | null;
  workspace: boolean;
  pilot: boolean;
}): ChatLaunch | null {
  if (!input.workspace || !input.pilot) return null;
  const launch = chatLaunchForArgv(input.cmd, input.args);
  if (!launch || !chatAvailable(input.catalog, launch.driver)) return null;
  return launch;
}

/** Whether the thread answering for a scope is driven over a protocol. */
export function isPilotOrchestrator(scope: string | null): boolean {
  return findOrchestrator(scope)?.runtime === "pilot";
}

/** The live orchestrator for a scope, or null. The row is the proof. */
export function findOrchestrator(scope: string | null): Thread | null {
  return (
    app.threads.find(
      (th) =>
        th.role === "orchestrator" &&
        (th.orchestratorScope ?? null) === (scope ?? null) &&
        !th.settledAt,
    ) ?? null
  );
}

/**
 * Someone to talk to: the live thread if there is one (woken if it dozed off),
 * a fresh one otherwise. Null when the experiment is not armed or nothing can
 * launch, with the user told why.
 */
export async function ensureOrchestrator(
  scope: string | null = null,
): Promise<Thread | null> {
  const conduct = backend().conduct;
  if (!conduct) return null;

  const existing = findOrchestrator(scope);
  if (existing) {
    // Idle sleep reuses the auto-sleep machinery, so waking is an ordinary
    // silent reload: resume-args rebuilds the command line with the session.
    if (existing.autoSlept) {
      await reloadThread(existing.id, { silent: true });
    }
    return app.threadById(existing.id) ?? existing;
  }

  const launch = resolveLaunch(settings.state.orchestratorAgent, "claude");
  if (!launch) {
    notifications.error(
      t("orchestrator.noAgent", { agent: settings.state.orchestratorAgent ?? "" }),
    );
    return null;
  }

  // A global orchestrator still lives in a project row; the active one is the
  // least surprising home, any live project works.
  const project = scope
    ? app.projects.find((p) => p.id === scope)
    : (app.projects.find((p) => p.id === app.selectedProjectId && !p.archived) ??
      app.projects.find((p) => !p.archived));
  if (!project) {
    notifications.error(t("orchestrator.noProject"));
    return null;
  }

  const args = withUnattendedArgs(launch.cmd, launch.args, launch.iconKey);
  // Which runtime this orchestrator is driven on, decided before the row is
  // written: the five pilot columns have to be in the INSERT, since everything
  // that reads the row afterwards branches on `runtime` in the same frame. The
  // catalog is asked first because the answer depends on which drivers this
  // machine actually has.
  await pilotCatalog.ensure();
  const chat = orchestratorChatLaunch({
    cmd: launch.cmd,
    args,
    catalog: pilotCatalog.current,
    workspace: settings.state.experimentWorkspace,
    pilot: settings.state.experimentPilot,
  });
  const thread = await launchAgent(
    project,
    { ...launch, args },
    { focus: false, deferActivation: true, pilot: chat },
  );
  if (!thread) return null;

  try {
    // The launch fired the INSERT without waiting; the stamp below verifies
    // against the row, so land it first. A re-save of the same row is safe.
    await app.upsertThread({ ...thread, args: [...thread.args] });
    await conduct.start({ threadId: thread.id, scope });
  } catch (err) {
    // ORCHESTRATOR_TAKEN: another window won the race. Their thread is the
    // orchestrator; ours is a plain terminal the user never asked for.
    logger.warn("orchestrator", "start refused", String(err));
    const winner = findOrchestrator(scope);
    if (winner) return winner;
    notifications.error(t("orchestrator.startFailed", { error: String(err) }));
    return null;
  }

  const row = app.threadById(thread.id);
  if (row) {
    row.role = "orchestrator";
    row.orchestratorScope = scope;
  }
  if (chat) {
    // A chat orchestrator has no PTY and no pane of its own: its conversation
    // is the Home card, and `home` is not a pane an agent may open. So the
    // session is opened on the host instead of a group being mounted, and it is
    // awaited, because the first post is a turn on it. The role is on the row
    // by now, which is what puts the briefing in front of the conversation.
    await openPilotSession(thread.id);
    return app.threadById(thread.id) ?? thread;
  }
  // Now the row carries the role, the PTY may spawn and read it.
  app.requestActivation(thread.id);
  return app.threadById(thread.id) ?? thread;
}

/** The user's message: make sure someone is listening, then write it. */
export async function postToOrchestrator(
  text: string,
  scope: string | null = null,
): Promise<boolean> {
  const conduct = backend().conduct;
  if (!conduct) return false;

  // Read before the launch, because launching is what changes the answer. A
  // thread already mid-turn is the one case the pulse covers on its own: the
  // agent is inside `workspace_pulse` or working, and `chat.posted` reaches it
  // there. Every other case ends at a prompt nobody is typing at, which is
  // what "the orchestrator does not answer" was.
  const before = findOrchestrator(scope);
  const listening =
    !!before &&
    !before.autoSlept &&
    (before.status === "running" || before.status === "waiting");

  const thread = await ensureOrchestrator(scope);
  if (!thread) return false;
  try {
    await conduct.post({ scope, text });
  } catch (err) {
    logger.error("orchestrator", "post failed", String(err));
    notifications.error(t("orchestrator.postFailed"));
    return false;
  }
  // A chat orchestrator has already been handed the line: the bus turned the
  // post into its turn. Nothing is typed anywhere, and there is no prompt to
  // wait for.
  if (thread.runtime === "pilot") return true;
  if (!listening) {
    // Not awaited: the row is written and the chat has the user's bubble, so
    // the send is done. This waits on a prompt that may be twenty seconds
    // away, and blocking the composer on it would read as a hung send.
    void typeIntoOrchestrator(thread.id, text);
  }
  return true;
}
