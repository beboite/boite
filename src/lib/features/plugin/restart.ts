import type { IconKey, ThreadStatus } from "$lib/types";
import { detectIconKey } from "$lib/shared/icons/detect";

/**
 * Whether this thread is a Codex row that should come back after
 * `codex-account-switcher activate`.
 */
export function shouldReloadCodexThread(thread: {
  iconKey: IconKey;
  cmd: string;
  label: string;
  status: ThreadStatus;
  sessionId: string | null;
  ptyId: string | null;
}): boolean {
  const key = thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
  if (key !== "codex") return false;
  if (thread.status === "idle" && !thread.sessionId && !thread.ptyId) return false;
  return true;
}
