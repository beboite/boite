import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import type { Backend } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";
import { paneStore, leavesOf } from "$lib/features/panes/store.svelte";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { liveTerminal, terminalScreenRows } from "$lib/features/terminal/live";
import { notifyWhenUnfocused } from "$lib/storage/notify";
// Aliased: `t` is the loop variable for a thread all through this file.
import { t as translate } from "$lib/i18n/index.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { ptyKill } from "$lib/storage/pty";
import { logger } from "$lib/shared/services/logger.svelte";
import { claudeTurn } from "./agentTurn";
import { threadCwd } from "./cwd";
import { detectWorkingOnScreen, LIVE_ROW_COUNT } from "./working-detect";
import type { IconKey, Thread } from "$lib/types";

/**
 * Who is working, recomputed from scratch twice a second.
 *
 * Two things about this file used to be wrong in the same way, and both showed
 * up as an agent that had finished and stayed lit until the user clicked it:
 *
 * The status was latched, not measured. A working signal stamped a timestamp
 * and the thread read as running until that stamp aged out, so "finished" was
 * only ever the absence of evidence, and the evidence came from a rolling
 * window of printed bytes that kept re-matching itself long after the turn
 * ended (see `working-detect.ts`). Nothing in the loop could ever conclude a
 * turn was over; it could only fail to notice it continuing.
 *
 * The loop itself was owned by the terminals. `acquire`/`release` ran off a
 * refcount of mounted `Terminal` components, so the sweep that demotes threads
 * only existed while at least one local pane was mounted. In dynamic mode, with
 * the boite's panes open and no local one, it did not run at all, and every
 * local thread kept whatever status it had when the last one closed. Clicking a
 * project mounted a pane, which restarted the sweep, which is why clicking is
 * what repaired it.
 *
 * So: one ticker for the lifetime of the window, and every pass answers "is
 * this thread working" from live state only. There is no TTL left to tune.
 */

// The sampling rate of the dot, not a grace period: every pass is a fresh read,
// so this is only how long a turn boundary can go unnoticed.
const TICK_MS = 500;

// Auto-sleep liveness. Deliberately not the same thing as the working signal:
// these say "something happened recently", which is enough to refuse to kill a
// PTY and not enough to light the running dot (a chatty plain shell and a
// just-finished agent both qualify).
//   lastOutputAt:     any raw PTY byte; an agent running a shell or a subagent
//                     keeps emitting even when its own footer is gone.
//   lastTranscriptAt: the agent's session jsonl was written while the terminal
//                     was visually quiet. Fed by the session monitor.
//   lastWorkingAt:    the last pass that concluded this thread was working.
const lastOutputAt = new Map<string, number>();
const lastTranscriptAt = new Map<string, number>();
const lastWorkingAt = new Map<string, number>();
const prevStatus = new Map<string, string>();
// Auto-sleep countdown anchor, kept apart from the activity stamps: arming the
// countdown by stamping one of those made the next pass read it as activity.
const idleSince = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;

function forgetThread(threadId: string) {
  lastOutputAt.delete(threadId);
  lastTranscriptAt.delete(threadId);
  lastWorkingAt.delete(threadId);
  prevStatus.delete(threadId);
  idleSince.delete(threadId);
}

function maybeAutoClose(threadId: string, iconKey: string | null | undefined) {
  if (!iconKey || iconKey === "terminal") return;
  const minutes = settings.state.idleTimeoutMinutes;
  if (!minutes || minutes <= 0) return;
  const enabled = settings.state.idleAutocloseByIcon[iconKey] === true;
  if (!enabled) return;
  const t = app.threadById(threadId);
  if (!t || !t.ptyId) return;
  if (t.keepAwake) return;
  if (!t.sessionId) {
    logger.debug("idle", `skip auto-sleep for ${t.label}: no session captured yet`, {
      iconKey,
    });
    return;
  }
  const now = Date.now();
  // Real recent activity vetoes the countdown: the thread having been working,
  // any raw PTY output, or a freshly written session transcript. This is what
  // keeps a long quiet tool call or an output-streaming subagent from getting
  // its PTY killed mid-work while the dot reads "ready".
  const timeoutMs = minutes * 60_000;
  const lastActivity = Math.max(
    lastWorkingAt.get(threadId) ?? 0,
    lastOutputAt.get(threadId) ?? 0,
    lastTranscriptAt.get(threadId) ?? 0,
  );
  if (lastActivity > 0 && now - lastActivity < timeoutMs) {
    idleSince.delete(threadId);
    return;
  }
  // Anchor the countdown to the last real activity, not to the moment we
  // noticed it had gone stale. Arming at `now` re-ran the full timeout on top
  // of the one already elapsed, so a 10-minute setting slept the thread after
  // ~20. A thread with no activity at all anchors at now (nothing to measure
  // from), which is the only case where the wait is a full timeout.
  const armed = idleSince.get(threadId) ?? (lastActivity || now);
  if (!idleSince.has(threadId)) {
    idleSince.set(threadId, armed);
    logger.debug("idle", `armed auto-sleep for ${t.label}`, {
      iconKey,
      timeoutMinutes: minutes,
      sinceMs: now - armed,
    });
  }
  const idleMs = now - armed;
  if (idleMs < timeoutMs) return;
  const pid = t.ptyId;
  app.setThreadPtyId(t.id, null);
  // setThreadStatus persists terminal statuses; no second hand-built save.
  app.setThreadStatus(t.id, "stopped", null);
  app.setThreadAutoSlept(t.id, true);
  void ptyKill(pid, false).catch((err) => {
    logger.warn("idle", `failed to kill ${t.label} during auto-sleep`, String(err));
  });
  logger.info("idle", `auto-slept ${t.label} after ${minutes}m idle`, {
    iconKey,
    idleMs,
    ptyId: pid,
  });
}

function visibleThreadIds(): Set<string> {
  const id = app.activeThreadId;
  if (!id) return new Set();
  const g = paneStore.groupOf(id);
  if (!g) return new Set([id]);
  return new Set(leavesOf(g.root));
}

/**
 * Whether this thread is mid-turn, or null when there is nothing to look at.
 *
 * Both answers are positive evidence, which is the point: a `false` here means
 * something was read and it said the turn is over, so the dot can be demoted on
 * it. Only `null`, a thread whose pane has never been opened so no emulator
 * ever held its rows, leaves the previous status alone.
 */
function readWorking(t: Thread, iconKey: IconKey): boolean | null {
  // Claude's own answer first. It rewrites its session registry as each turn
  // starts and ends, so this is the agent stating what it is doing rather than
  // Boite inferring it, and it stays right through a quiet tool call, a
  // subagent, a compaction and a hidden pane.
  //
  // The cwd is passed so a thread that has not captured its session id yet can
  // still be placed: those first seconds are part of the agent's opening turn,
  // which is the one most likely to spend ten silent minutes in a subagent.
  if (iconKey === "claude") {
    const cwd = threadCwd(t, app.projectById(t.projectId));
    const declared = claudeTurn.stateOf(t.sessionId, cwd);
    if (declared) return declared === "busy";
  }
  // Otherwise the rows the agent is repainting. Level, not latched: the footer
  // is on screen or it is not.
  const term = liveTerminal(t.id);
  if (!term) return null;
  return detectWorkingOnScreen(terminalScreenRows(term, LIVE_ROW_COUNT), iconKey);
}

function tick() {
  const now = Date.now();
  const visible = visibleThreadIds();
  // The one backend whose threads are judged here, handed to the registry poll
  // so it asks the machine the agents are actually running on.
  let sniffing: Backend | null = null;

  for (const t of app.threads) {
    // Server-owned threads (remote origin in dynamic mode) get their status
    // pushed as control events; ticking them would clobber it.
    const backend = workspace.backendFor(t.origin);
    if (!backend.caps.clientStatus) continue;
    sniffing ??= backend;
    if (!t.ptyId) {
      // A parked local PTY is detached but still alive (workspace switch). Keep
      // its status + dot colour until the pane reattaches; demoting it to idle
      // would flatten the ping the user expects to stay lit.
      if (parkedLocal.has(t.id)) continue;
      forgetThread(t.id);
      if (t.status === "ready" || t.status === "running") {
        app.setThreadStatus(t.id, "idle");
      }
      continue;
    }
    if (
      t.status === "done" ||
      t.status === "exited" ||
      t.status === "error" ||
      t.status === "stopped"
    ) {
      prevStatus.set(t.id, t.status);
      idleSince.delete(t.id);
      continue;
    }

    // Detection resolves the key from the command when the row does not carry
    // one. A thread can predate the key being recorded, and reading nothing off
    // an agent's screen because of that is a bug. Auto-sleep below keeps using
    // the stored key: it kills PTYs, and its per-agent opt-in is a setting the
    // user made against the icons they can see, not against an inferred one.
    const iconKey = t.iconKey ?? detectIconKey(t.cmd, t.label);
    const working = readWorking(t, iconKey);
    if (working !== null) {
      if (working) lastWorkingAt.set(t.id, now);
      const next = working ? "running" : "ready";
      if (t.status !== next) {
        app.setThreadStatus(t.id, next);
      }
      if (prevStatus.get(t.id) === "running" && next === "ready") {
        const label = t.title ?? t.label;
        void notifyWhenUnfocused(label, translate("notification.readyForInput"));
      }
      prevStatus.set(t.id, next);
    }

    if (t.status === "ready" && !visible.has(t.id)) {
      maybeAutoClose(t.id, t.iconKey);
    } else {
      idleSince.delete(t.id);
    }
  }

  if (sniffing) claudeTurn.poll(sniffing);
}

export const statusEngine = {
  /**
   * Starts the sweep, for the lifetime of the window. Called once from the root
   * page: it must not depend on a pane being open, because the threads it
   * demotes are the ones nobody is looking at.
   */
  start() {
    if (timer !== null) return;
    timer = setInterval(tick, TICK_MS);
  },

  stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  },

  // Raw PTY output and transcript writes only defer auto-sleep; neither is
  // evidence of a turn in flight, so neither decides the dot.
  markOutput(threadId: string) {
    lastOutputAt.set(threadId, Date.now());
  },

  markTranscriptActive(threadId: string) {
    lastTranscriptAt.set(threadId, Date.now());
  },

  /** Drops a thread's bookkeeping. Its terminal is going away with it. */
  forget(threadId: string) {
    forgetThread(threadId);
  },
};
