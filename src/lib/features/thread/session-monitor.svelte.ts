import { app } from "$lib/app/store.svelte";
import { backend } from "$lib/backend";
import { saveThread, updateThreadTitle } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { statusEngine } from "./statusEngine";
import type { SessionDetector } from "./session";
import type { Thread } from "$lib/types";

const SESSION_SCAN_INTERVAL_MS = 12_000;
// A session file written by a thread's process is modified while that PTY is
// streaming, so file mtime and thread activity land within a few seconds of
// each other.
const ATTRIBUTION_WINDOW_MS = 5_000;
// Transcript liveness: a captured session whose jsonl was written this recently
// means the agent is actively working (a tool call, a subagent step, streamed
// tokens) even when the terminal is visually quiet. This only defers auto-sleep
// so the PTY isn't killed mid-work; it never lights the running dot, because a
// just-finished session is "recently written" too.
const TRANSCRIPT_LIVENESS_WINDOW_MS = 20_000;

// Single in-flight slot across ALL monitors. Two sibling terminals scanning
// concurrently could both see the same unclaimed jsonl and both claim it.
let scanInFlight = false;

// Live monitors by threadId, so a scan can check whether a candidate session
// file could belong to a sibling thread in the same cwd instead.
const liveMonitors = new Map<
  string,
  { cwd: string; lastActivityAt: () => number }
>();

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

// Prompt-derived titles (codex never emits a descriptive OSC title) only fill
// an unnamed thread; an OSC-set or user-visible title always wins.
function applySessionTitle(t: Thread, title: string | null | undefined) {
  if (!title || t.title) return;
  app.setThreadTitle(t.id, title);
  // Remote: setThreadTitle skips persistence (the server owns OSC titles),
  // but this title only exists client-side, so persist it explicitly.
  if (!backend().caps.clientStatus) {
    void updateThreadTitle(t.id, title).catch(() => {});
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
    if (liveMonitors.get(threadId)?.lastActivityAt === opts.lastActivityAt) {
      liveMonitors.delete(threadId);
    }
    if (timer) clearInterval(timer);
    timer = null;
    for (const t of timeouts) clearTimeout(t);
    timeouts = [];
  };

  // With several threads on the same cwd, "newest session file" alone picks
  // the wrong owner: a /clear or new conversation in thread A used to get
  // claimed by thread B's monitor, swapping their sessions. Only claim a file
  // whose mtime correlates with OUR pty activity and with no sibling's.
  const attributedToSelf = (mtimeMs: number): boolean => {
    const siblings = [...liveMonitors.entries()].filter(
      ([id, m]) => id !== threadId && m.cwd === cwd,
    );
    if (siblings.length === 0) return true;
    const ownNear =
      Math.abs(mtimeMs - opts.lastActivityAt()) <= ATTRIBUTION_WINDOW_MS;
    const siblingNear = siblings.some(
      ([, m]) => Math.abs(mtimeMs - m.lastActivityAt()) <= ATTRIBUTION_WINDOW_MS,
    );
    return ownNear && !siblingNear;
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
    // Exception: while this thread has no title yet, keep its own session in
    // play so the detector can return it again and backfill the prompt-derived
    // title once the user's first message lands in the transcript.
    const excludeIds = app.threads
      .map((x) => x.sessionId)
      .filter((id): id is string => !!id)
      .filter((id) => id !== t.sessionId || !!t.title);

    scanInFlight = true;
    try {
      const hit = await detector(cwd, sinceMs, excludeIds);
      if (!hit) {
        if (t.sessionId) {
          logger.debug(
            "session",
            `${t.label}: locked on ${t.sessionId}, no new session detected`,
            { cwd, probeSince: sinceMs },
          );
        }
        return false;
      }
      const id = hit.id;
      if (hit.mtimeMs != null && !attributedToSelf(hit.mtimeMs)) {
        logger.debug(
          "session",
          `${t.label}: ${id} not attributable to this thread, deferring`,
          { mtimeMs: hit.mtimeMs, lastActivityAt: opts.lastActivityAt() },
        );
        return false;
      }
      if (id === t.sessionId) {
        applySessionTitle(t, hit.title);
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
      applySessionTitle(t, hit.title);
      return false;
    } catch (err) {
      logger.error("session", `detect failed for ${t.label}`, String(err));
      return false;
    } finally {
      scanInFlight = false;
    }
  };

  // Independent of capture: once a session is locked, check whether ITS jsonl
  // was just written and, if so, defer auto-sleep. Reuses the detector by
  // excluding every other thread's session, so a fresh write in this cwd
  // resolves back to ours.
  let livenessInFlight = false;
  const probeLiveness = async () => {
    if (livenessInFlight) return;
    if (!backend().caps.clientStatus) return;
    const t = app.threads.find((x) => x.id === threadId);
    if (
      !t ||
      !t.sessionId ||
      t.ptyId !== targetPtyId ||
      !opts.isPtyCurrent(targetPtyId)
    ) {
      return;
    }
    const ownId = t.sessionId;
    const excludeOthers = app.threads
      .map((x) => x.sessionId)
      .filter((id): id is string => !!id && id !== ownId);
    livenessInFlight = true;
    try {
      const hit = await detector(
        cwd,
        Date.now() - TRANSCRIPT_LIVENESS_WINDOW_MS,
        excludeOthers,
      );
      if (hit?.id === ownId) statusEngine.markTranscriptActive(threadId);
    } catch {
      // Best-effort; the capture scan already logs detector failures.
    } finally {
      livenessInFlight = false;
    }
  };

  const runScan = () => {
    if (stopped) return;
    void probeLiveness();
    void scanOnce().then((done) => {
      if (done) stop();
    });
  };

  liveMonitors.set(threadId, { cwd, lastActivityAt: opts.lastActivityAt });
  timeouts = [setTimeout(runScan, 3000), setTimeout(runScan, 8000)];
  timer = setInterval(runScan, SESSION_SCAN_INTERVAL_MS);

  return { stop };
}
