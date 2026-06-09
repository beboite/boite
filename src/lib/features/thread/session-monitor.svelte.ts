import { app } from "$lib/app/store.svelte";
import { saveThread } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import type { SessionDetector } from "./session";
import type { Thread } from "$lib/types";

const SESSION_SCAN_INTERVAL_MS = 12_000;

// Single in-flight slot across ALL monitors. Two sibling terminals scanning
// concurrently could both see the same unclaimed jsonl and both claim it.
let scanInFlight = false;

export interface SessionMonitor {
  stop(): void;
}

export async function persistSessionId(
  t: Thread,
  id: string | null,
  cwd: string,
  opts: { silent?: boolean } = {},
) {
  if (t.sessionId === id) return;
  const previous = t.sessionId;
  t.sessionId = id;
  await saveThread($state.snapshot(t) as Thread);
  if (id) app.clearUnbound(t.id);
  logger.info(
    "session",
    `${id ? (previous ? "updated" : "captured") : "cleared"} ${t.iconKey ?? "?"} session for ${t.label}`,
    { id, previous, cwd },
  );
  if (!opts.silent && id) {
    notifications.success(
      previous ? `Session updated (${t.label})` : `Session captured (${t.label})`,
    );
  }
}

function probeSince(
  t: Thread,
  initialSince: number,
  lastActivityAt: number,
): number | null {
  if (!t.sessionId) return initialSince;
  if (!lastActivityAt) return null;
  if (Date.now() - lastActivityAt > SESSION_SCAN_INTERVAL_MS * 2) return null;
  return Math.max(initialSince, lastActivityAt - 2000);
}

export function startSessionMonitor(opts: {
  threadId: string;
  cwd: string;
  detector: SessionDetector;
  since: number;
  targetPtyId: string;
  isPtyCurrent: (ptyId: string) => boolean;
  lastActivityAt: () => number;
}): SessionMonitor {
  const { threadId, cwd, detector, since, targetPtyId } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let timeouts: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    for (const t of timeouts) clearTimeout(t);
    timeouts = [];
  };

  const scanOnce = async (): Promise<boolean> => {
    if (scanInFlight) return false;
    const t = app.threads.find((x) => x.id === threadId);
    if (!t || t.ptyId !== targetPtyId || !opts.isPtyCurrent(targetPtyId)) {
      return true;
    }
    const sinceMs = probeSince(t, since, opts.lastActivityAt());
    if (sinceMs == null) return false;

    // Exclude every sessionId already claimed by any thread (incl. self).
    // Otherwise sibling monitors keep stealing each other's session in a
    // loop because the detector always returns the newest jsonl in the cwd.
    const excludeIds = app.threads
      .map((x) => x.sessionId)
      .filter((id): id is string => !!id);

    scanInFlight = true;
    try {
      const id = await detector(cwd, sinceMs, excludeIds);
      if (!id) {
        if (t.sessionId) {
          logger.debug(
            "session",
            `${t.label}: locked on ${t.sessionId}, no new session detected`,
            { cwd, probeSince: sinceMs },
          );
        }
        return false;
      }
      if (id === t.sessionId) {
        logger.debug(
          "session",
          `${t.label}: detector returned current session, skip`,
          { id },
        );
        return false;
      }
      const sibling = app.threads.find(
        (x) => x.id !== threadId && x.sessionId === id,
      );
      if (sibling) {
        logger.warn(
          "session",
          `${t.label}: claiming ${id} from sibling ${sibling.label}`,
          { id, sibling: sibling.label },
        );
        notifications.success(`Session reassigned: ${sibling.label} → ${t.label}`);
        await persistSessionId(sibling, null, cwd, { silent: true });
      }
      logger.info(
        "session",
        `${t.label}: ${t.sessionId ? "manual switch" : "captured"} ${t.sessionId ?? "(none)"} → ${id}`,
        { cwd, previous: t.sessionId, next: id },
      );
      await persistSessionId(t, id, cwd);
      return false;
    } catch (err) {
      logger.error("session", `detect failed for ${t.label}`, String(err));
      return false;
    } finally {
      scanInFlight = false;
    }
  };

  const runScan = () => {
    if (stopped) return;
    void scanOnce().then((done) => {
      if (done) stop();
    });
  };

  timeouts = [setTimeout(runScan, 3000), setTimeout(runScan, 8000)];
  timer = setInterval(runScan, SESSION_SCAN_INTERVAL_MS);

  return { stop };
}
