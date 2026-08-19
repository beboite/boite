import { app } from "$lib/app/store.svelte";
import { resolveLaunch } from "$lib/app/agent-requests";
import { backend } from "$lib/backend/active.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { launchAgent, reloadThread } from "$lib/features/thread/api";
import { withUnattendedArgs } from "$lib/features/thread/session";
import { logger } from "$lib/shared/services/logger.svelte";
import { notifications } from "$lib/features/notifications/store.svelte";
import { t } from "$lib/i18n/index.svelte";
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
  const thread = await launchAgent(
    project,
    { ...launch, args },
    { focus: false, deferActivation: true },
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
  const thread = await ensureOrchestrator(scope);
  if (!thread) return false;
  try {
    await conduct.post({ scope, text });
    return true;
  } catch (err) {
    logger.error("orchestrator", "post failed", String(err));
    notifications.error(t("orchestrator.postFailed"));
    return false;
  }
}
