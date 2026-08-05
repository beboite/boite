import { app } from "$lib/app/store.svelte";
import { backendFor } from "$lib/backend";
import { saveThread, updateThreadTitle } from "$lib/storage/db";
import { notifications } from "$lib/features/notifications/store.svelte";
import { logger } from "$lib/shared/services/logger.svelte";
import { t } from "$lib/i18n/index.svelte";
import { statusEngine } from "./statusEngine";
import type { SessionDetector } from "./session";
import type { Thread } from "$lib/types";

const SESSION_SCAN_INTERVAL_MS = 12_000;
// A session file written by a thread's process is modified while that PTY is
// streaming, so file mtime and thread activity land within a few seconds of
// each other.
const ATTRIBUTION_WINDOW_MS = 5_000;
// How many scans may be spent refusing to attribute a transcript before the
// refusal is worth a line somebody will read. `debug` is compiled out of a
// release build, so the one failure that leaves a thread permanently unbound —
// and therefore relaunching into a blank conversation — used to say nothing at
// all in the builds it happened in.
const DEFER_WARN_AT = 3;
// The same idea for a thread that finds nothing at all: said once, well after
// the scans that are simply early (3s, 8s, then every 12s).
const UNBOUND_INFO_AT = 5;
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
  { cwd: string; kind: string; lastActivityAt: () => number }
>();

export interface SessionMonitor {
  stop(): void;
}

export async function persistSessionId(
  thread: Thread,
  id: string | null,
  cwd: string,
  opts: { silent?: boolean } = {},
) {
  if (thread.sessionId === id) return;
  const previous = thread.sessionId;
  thread.sessionId = id;
  await saveThread($state.snapshot(thread) as Thread);
  if (id) app.clearUnbound(thread.id);
  logger.info(
    "session",
    `${id ? (previous ? "updated" : "captured") : "cleared"} ${thread.iconKey ?? "?"} session for ${thread.label}`,
    { id, previous, cwd },
  );
  if (!opts.silent && id) {
    notifications.success(
      previous
        ? t("thread.sessionUpdated", { name: thread.label })
        : t("thread.sessionCaptured", { name: thread.label }),
    );
  }
}

// Prompt-derived titles (codex never emits a descriptive OSC title) only fill
// an unnamed thread; an OSC-set or user-visible title always wins.
function applySessionTitle(thread: Thread, title: string | null | undefined) {
  if (!title || thread.title) return;
  app.setThreadTitle(thread.id, title);
  // Remote: setThreadTitle skips persistence (the server owns OSC titles),
  // but this title only exists client-side, so persist it explicitly.
  if (!backendFor(thread.origin).caps.clientStatus) {
    void updateThreadTitle(thread.id, title, thread.origin).catch(() => {});
  }
}

function probeSince(
  thread: Thread,
  initialSince: number,
  lastActivityAt: number,
): number | null {
  if (!thread.sessionId) return initialSince;
  if (!lastActivityAt) return null;
  if (Date.now() - lastActivityAt > SESSION_SCAN_INTERVAL_MS * 2) return null;
  return Math.max(initialSince, lastActivityAt - 2000);
}

export function startSessionMonitor(opts: {
  threadId: string;
  cwd: string;
  /** The agent whose store this monitor's detector reads. */
  kind: string;
  detector: SessionDetector;
  since: number;
  targetPtyId: string;
  isPtyCurrent: (ptyId: string) => boolean;
  lastActivityAt: () => number;
}): SessionMonitor {
  const { threadId, cwd, kind, detector, since, targetPtyId } = opts;
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
    for (const handle of timeouts) clearTimeout(handle);
    timeouts = [];
  };

  // How many consecutive scans have found a transcript and refused it, and how
  // many have found nothing at all while this thread has no session.
  let deferrals = 0;
  let emptyScans = 0;

  // The guess, for the agents whose store cannot answer who owns what. Claude
  // can — `hit.ownPid` is its registry naming the process behind this very PTY
  // — and a fact is never put to a vote below.
  //
  // With several threads on the same cwd, "newest session file" alone picks
  // the wrong owner: a /clear or new conversation in thread A used to get
  // claimed by thread B's monitor, swapping their sessions. Only claim a file
  // whose mtime correlates with OUR pty activity and with no sibling's.
  //
  // Two agents of the same kind, both busy in one folder, are the case this
  // cannot settle: each is "recently active" whenever the other writes, so
  // neither ever attributes anything and both stay unbound for as long as they
  // run. That is what `ownPid` exists to skip.
  //
  // Same agent only. Each detector reads one agent's store, so a codex thread
  // is never a candidate owner of a claude transcript and has no business
  // vetoing it. Counting it did: one busy agent in the cwd held its neighbours
  // permanently unattributable, since a streaming sibling is "recently active"
  // on every scan, and they never captured anything at all.
  const attributedToSelf = (mtimeMs: number): boolean => {
    const siblings = [...liveMonitors.entries()].filter(
      ([id, m]) => id !== threadId && m.cwd === cwd && m.kind === kind,
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
    const thread = app.threadById(threadId);
    if (
      !thread ||
      thread.ptyId !== targetPtyId ||
      !opts.isPtyCurrent(targetPtyId)
    ) {
      return true;
    }
    const sinceMs = probeSince(thread, since, opts.lastActivityAt());
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
      .filter((id) => id !== thread.sessionId || !!thread.title);

    scanInFlight = true;
    try {
      // Our own pty, so the session it is running is not filtered out as
      // "live" — it is the one being claimed.
      const hit = await detector(cwd, sinceMs, excludeIds, targetPtyId);
      if (!hit) {
        if (thread.sessionId) {
          logger.debug(
            "session",
            `${thread.label}: locked on ${thread.sessionId}, no new session detected`,
            { cwd, probeSince: sinceMs },
          );
          return false;
        }
        // An unbound thread whose agent has written nothing findable. Ordinary
        // for the first scans of a thread nobody has typed into yet, which is
        // why it is said once and late rather than every 12s: what it explains
        // is a relaunch that started a blank conversation, read afterwards.
        emptyScans++;
        if (emptyScans === UNBOUND_INFO_AT) {
          logger.info(
            "session",
            `${thread.label}: nothing to bind to after ${emptyScans} scans`,
            { cwd, probeSince: sinceMs },
          );
        }
        return false;
      }
      emptyScans = 0;
      const id = hit.id;
      if (hit.mtimeMs != null && !hit.ownPid && !attributedToSelf(hit.mtimeMs)) {
        deferrals++;
        const details = {
          mtimeMs: hit.mtimeMs,
          lastActivityAt: opts.lastActivityAt(),
          deferrals,
        };
        // Said once, at the point where deferring has stopped looking like a
        // scan that came too early. Repeating it every 12s for the life of the
        // thread would bury the log it is meant to reach.
        if (deferrals === DEFER_WARN_AT) {
          logger.warn(
            "session",
            `${thread.label}: ${id} is unattributable after ${deferrals} scans; nothing is bound, so a relaunch would start a fresh conversation`,
            details,
          );
        } else {
          logger.debug(
            "session",
            `${thread.label}: ${id} not attributable to this thread, deferring`,
            details,
          );
        }
        return false;
      }
      deferrals = 0;
      if (id === thread.sessionId) {
        applySessionTitle(thread, hit.title);
        logger.debug(
          "session",
          `${thread.label}: detector returned current session, skip`,
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
          `${thread.label}: claiming ${id} from sibling ${sibling.label}`,
          { id, sibling: sibling.label },
        );
        notifications.success(
          t("thread.sessionReassigned", {
            from: sibling.label,
            to: thread.label,
          }),
        );
        await persistSessionId(sibling, null, cwd, { silent: true });
      }
      logger.info(
        "session",
        `${thread.label}: ${thread.sessionId ? "manual switch" : "captured"} ${thread.sessionId ?? "(none)"} → ${id}`,
        // How it was decided, because the two are worth different amounts when
        // a binding later turns out to be wrong: `pid` is the agent's registry
        // naming this PTY's process, `mtime` is the timestamp guess.
        { cwd, previous: thread.sessionId, next: id, by: hit.ownPid ? "pid" : "mtime" },
      );
      await persistSessionId(thread, id, cwd);
      applySessionTitle(thread, hit.title);
      return false;
    } catch (err) {
      logger.error("session", `detect failed for ${thread.label}`, String(err));
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
    const thread = app.threadById(threadId);
    if (thread && !backendFor(thread.origin).caps.clientStatus) return;
    if (
      !thread ||
      !thread.sessionId ||
      thread.ptyId !== targetPtyId ||
      !opts.isPtyCurrent(targetPtyId)
    ) {
      return;
    }
    const ownId = thread.sessionId;
    const excludeOthers = app.threads
      .map((x) => x.sessionId)
      .filter((id): id is string => !!id && id !== ownId);
    livenessInFlight = true;
    try {
      const hit = await detector(
        cwd,
        Date.now() - TRANSCRIPT_LIVENESS_WINDOW_MS,
        excludeOthers,
        targetPtyId,
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

  liveMonitors.set(threadId, { cwd, kind, lastActivityAt: opts.lastActivityAt });
  timeouts = [setTimeout(runScan, 3000), setTimeout(runScan, 8000)];
  timer = setInterval(runScan, SESSION_SCAN_INTERVAL_MS);

  return { stop };
}
