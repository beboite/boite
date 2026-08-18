import type { IconKey, ThreadStatus } from "$lib/types";
import { detectIconKey } from "$lib/shared/icons/detect";

/**
 * Which kebacc-switch pool a thread belongs to, if it is Claude or Codex.
 */
export function kebaccProviderOf(thread: {
  iconKey: IconKey;
  cmd: string;
  label: string;
}): "claude" | "codex" | null {
  const key = thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
  if (key === "claude") return "claude";
  if (key === "codex") return "codex";
  return null;
}

export function shouldReloadKebaccThread(
  thread: {
    iconKey: IconKey;
    cmd: string;
    label: string;
    status: ThreadStatus;
    sessionId: string | null;
    ptyId: string | null;
  },
  provider: "claude" | "codex",
): boolean {
  if (kebaccProviderOf(thread) !== provider) return false;
  if (thread.status === "idle" && !thread.sessionId && !thread.ptyId) return false;
  return true;
}

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
