import type { IconKey, ThreadStatus } from "$lib/types";
import { detectIconKey } from "$lib/shared/icons/detect";

export const ACCOUNT_PROVIDERS = ["claude", "codex", "antigravity"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

export function isAccountProvider(value: string): value is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Which login pool a thread drinks from, if any.
 *
 * The icon is derived from cmd/label, so a fastpick row still names Claude
 * rather than fastpick.
 */
export function accountProviderOf(thread: {
  iconKey: IconKey;
  cmd: string;
  label: string;
}): AccountProvider | null {
  const key = thread.iconKey ?? detectIconKey(thread.cmd, thread.label);
  if (!key) return null;
  return isAccountProvider(key) ? key : null;
}

export function shouldReloadProviderThread(
  thread: {
    iconKey: IconKey;
    cmd: string;
    label: string;
    status: ThreadStatus;
    sessionId: string | null;
    ptyId: string | null;
  },
  provider: string,
): boolean {
  if (accountProviderOf(thread) !== provider) return false;
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
  return shouldReloadProviderThread(thread, "codex");
}
