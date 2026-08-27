import { workspace } from "$lib/backend";
import { logger } from "$lib/shared/services/logger.svelte";
import type { Backend } from "$lib/backend/types";

/**
 * Which transport an agent request came in on, and therefore which one owes it
 * an answer.
 *
 * Its own module because it is the one part of `agent-requests` that has to be
 * testable on its own: everything else there mounts terminals and opens panes,
 * and the routing question is answerable with a workspace and nothing else.
 */

/**
 * Which machine's process wrote the request.
 *
 * "boite" is the control plane: another machine's agent, whose idea of a path,
 * a port or loopback is not this window's. Carried rather than inferred from
 * `workspace.mode`, because in dynamic mode both arrive at the same handler.
 */
export type RequestSource = "device" | "boite";

/**
 * The transport that is holding the asking call open.
 *
 * Routed by who wrote the request and never by the active workspace, which is
 * the bug this replaces. `backend()` is `workspace.current()`, and in dynamic
 * mode that is the local device even while a boite's agent is the one waiting:
 * the answer went into the desktop's IPC, where the id means nothing, and the
 * agent sat out its timeout on the other side. Worse afterwards — the request
 * is broadcast to every device and claimed once, so an agent that gave up and
 * asked again had the work done twice.
 *
 * A device request is the mirror image: it arrived on this window's own Tauri
 * event bus, so its answer goes back down that bus whatever the mode is, and
 * pure remote mode must not send it to the boite.
 */
export function answerBackend(from: RequestSource): Backend | null {
  return from === "boite" ? workspace.remoteBackend : workspace.local();
}

/** Hand one answer back down the transport the question arrived on. */
export async function answerRequest(
  req: { requestId?: string },
  payload: Record<string, unknown>,
  from: RequestSource,
): Promise<void> {
  const id = req.requestId;
  if (!id) return;
  const be = answerBackend(from);
  if (!be?.answerAgentRequest) {
    logger.warn("agent-request", "no channel to answer on, dropping the answer", { from });
    return;
  }
  // Called on the backend rather than pulled off it: `RemoteBackend` answers
  // through a private socket field, and a detached reference throws before it
  // reaches the wire.
  await be.answerAgentRequest(id, payload).catch((err) => {
    logger.warn("agent-request", "could not answer", String(err));
  });
}
