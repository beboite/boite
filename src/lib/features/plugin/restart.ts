import type { PluginKind } from "$lib/backend/types";
import type { IconKey, ThreadStatus } from "$lib/types";
import { detectIconKey } from "$lib/shared/icons/detect";

/**
 * Whether this thread should come back after an account flip.
 *
 * A row that has never been started has nothing to pick the new login up
 * with. Everything else of that agent does: a live pane, a captured
 * session, or a thread that ran once and is now parked.
 */
export function shouldReloadAfterSwitch(
  thread: {
    iconKey: IconKey;
    cmd: string;
    label: string;
    status: ThreadStatus;
    sessionId: string | null;
    ptyId: string | null;
  },
  kind: PluginKind,
): boolean {
  const key = thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
  if (key !== kind) return false;
  if (thread.status === "idle" && !thread.sessionId && !thread.ptyId) return false;
  return true;
}
