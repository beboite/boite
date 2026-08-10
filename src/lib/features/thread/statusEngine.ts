import { isFinished } from "$lib/domain/thread-status";
import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import type { Backend } from "$lib/backend";
import type { AgentTurnQuery } from "$lib/backend/types";
import { settings } from "$lib/features/settings/store.svelte";
import { paneStore, threadLeavesOf } from "$lib/features/panes/store.svelte";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { liveTerminal, terminalScreenRows } from "$lib/shared/terminals";
import { notifyWhenUnfocused } from "$lib/storage/notify";
// Aliased: `t` is the loop variable for a thread all through this file.
import { t as translate } from "$lib/i18n/index.svelte";
import { detectIconKey } from "$lib/shared/icons/detect";
import { ptyKill } from "$lib/storage/pty";
import { logger } from "$lib/shared/services/logger.svelte";
import { agentTurns } from "./agent-turns";
import { turnIsActive } from "./agent-registry";
import { threadCwd } from "./cwd";
import { detectWorkingOnScreen, LIVE_ROW_COUNT } from "./working-detect";
import type { IconKey, Thread, ThreadStatus } from "$lib/types";

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
 * this thread working" from live state only.
 *
 * One TTL survives, and only where there is no live state at all to read: a
 * thread whose pane is gone and whose agent declares nothing (`UNREAD_TTL_MS`).
 * That is not the old grace period on a working signal, it is the backstop that
 * keeps "no answer" from meaning "keep the last answer forever".
 */

// The sampling rate of the dot, not a grace period: every pass is a fresh read,
// so this is only how long a turn boundary can go unnoticed.
const TICK_MS = 500;

/**
 * The one place a clock still decides anything, and only where nothing else can.
 *
 * `read` answers null for a thread with no emulator holding its rows and an agent
 * that declares nothing: a Terminal that unmounted while its PTY stayed alive
 * (the thread moved out of a group, its `rect` or `group` went away, a respawn key
 * flipped) running any of the five CLIs with no store to poll. Leaving the status
 * alone there is not "wrong for two seconds", it is wrong for the life of the
 * window: nothing will ever look at that thread again, so it stays lit, and being
 * stuck on `running` also keeps it out of auto-sleep, which only ever considers a
 * `ready` thread. Its PTY is then never reclaimed either.
 *
 * Mirrors WORKING_TTL and the `DeclaredTurn::Unknown` arm of `next_status` in
 * `boite-server/src/registry.rs`, which kept its equivalent throughout.
 */
const UNREAD_TTL_MS = 2000;

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
// What claude said it is blocked on, for the threads that are blocked. Kept in
// a map of its own rather than on the thread row: it is read from a store on
// disk every pass and it is gone the moment the dialog is answered, which is
// neither durable state nor something worth a database write.
const waitingReason = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;

function onVisibility() {
  if (!document.hidden) agentTurns.wake();
}

/**
 * `document`, where there is one.
 *
 * The sweep is started from the root page in a browser and from a bare node
 * environment in its own tests, and it must not need a DOM to run: what it
 * measures is thread state, and the visibility hook is a refinement on top.
 */
function windowDocument(): Document | null {
  return typeof document === "undefined" ? null : document;
}

function forgetThread(threadId: string) {
  lastOutputAt.delete(threadId);
  lastTranscriptAt.delete(threadId);
  lastWorkingAt.delete(threadId);
  prevStatus.delete(threadId);
  idleSince.delete(threadId);
  waitingReason.delete(threadId);
}

/**
 * Why this thread is waiting, in the agent's own words, or null.
 *
 * "Waiting" alone does not say whether the agent wants a permission, a plan
 * approved or an answer to a question, and those are three different amounts of
 * urgency. Claude is the only agent that says which.
 */
export function waitingReasonFor(threadId: string): string | null {
  return waitingReason.get(threadId) ?? null;
}

// Which workspace `prevStatus` describes. A switch replaces every thread and
// every backend under them, so the first status seen after one is this
// workspace's first reading rather than a transition out of the last one's. The
// local half already got there through the `{#key}` remount, which unmounts
// every Terminal and forgets its thread; a server-owned thread has no Terminal
// to unmount, so nothing would ever have cleared it.
let workspaceEpoch = workspace.epoch;

function dropStaleWorkspace() {
  if (workspace.epoch === workspaceEpoch) return;
  workspaceEpoch = workspace.epoch;
  prevStatus.clear();
}

/**
 * Raises whatever a status transition is worth telling the user, and records
 * what this thread now reads.
 *
 * Two different pieces of news, and telling them apart is the point. One is
 * "your agent is done", the other is "your agent cannot continue without you".
 * Reaching `waiting` from anywhere is worth saying; reaching `ready` only is
 * when a turn actually ended.
 *
 * Neither is said the first time a thread is seen. `before` is undefined after
 * a mount, a workspace switch or a `forget`, and a prompt that was already on
 * screen is not news: without the guard, every app start and every pane remount
 * notified for every thread sitting on an unanswered dialog. The `ready` arm
 * needs no guard of its own, since it only ever fires out of `running`.
 *
 * Exported because a server-owned thread never reaches the sweep below: the
 * boite decides its status and pushes it, and `applyControlEvent` is the only
 * place that ever sees the transition. A desktop driving a boite got neither
 * this notification nor a web push, since it has no web push at all, in exactly
 * the mode where the window is most likely to be behind something else.
 */
export function announceStatus(thread: Thread, next: ThreadStatus) {
  dropStaleWorkspace();
  const before = prevStatus.get(thread.id);
  const name = thread.title ?? thread.label;
  if (before !== undefined && next === "waiting" && before !== "waiting") {
    void notifyWhenUnfocused(name, translate("notification.waitingForYou"));
  } else if (next === "ready" && before === "running") {
    void notifyWhenUnfocused(name, translate("notification.readyForInput"));
  }
  prevStatus.set(thread.id, next);
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
  // In memory only, and deliberately: the row already carries the mark of this
  // run, and a sleep written down would have the next boot read it as the run
  // before this one and draw the thread as one that never started.
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
  return new Set(threadLeavesOf(g.root));
}

/**
 * What one pass concluded about a thread.
 *
 * `status` is what the dot should show. `active` is the separate question of
 * whether anything is in flight, and the two genuinely disagree: a thread waiting
 * on a permission prompt, or one whose agent has finished while a shell it
 * launched keeps running, is not the agent working and is not finished either.
 * Auto-sleep reads `active`; the dot reads `status`.
 */
type Reading = {
  status: "running" | "waiting" | "ready";
  active: boolean;
  /** Only ever set alongside `waiting`, and only by claude. */
  waitingFor?: string | null;
};

/**
 * What this thread is doing, or null when there is nothing to look at.
 *
 * A non-null answer is positive evidence in every direction, which is the point:
 * `ready` here means something was read and it said the turn is over, so the dot
 * can be demoted on it. Only `null`, a thread whose pane has never been opened so
 * no emulator ever held its rows, leaves the previous status alone.
 */
function read(t: Thread, iconKey: IconKey): Reading | null {
  // The agent's own answer first, where it has one. Three of them do, each in a
  // different place (see `agent-registry.ts`), and all three state that a turn
  // ended rather than merely stopping to say it continues. That is what stays
  // right through a quiet tool call, a subagent, a compaction and a hidden pane.
  //
  // The cwd is passed so a thread that has not captured its session id yet can
  // still be placed: those first seconds are part of the agent's opening turn,
  // which is the one most likely to spend ten silent minutes in a subagent.
  if (iconKey) {
    const cwd = threadCwd(t, app.projectById(t.projectId));
    const turn = agentTurns.stateOf(iconKey, t.sessionId, cwd);
    if (turn) {
      // One definition of "mid-something", shared with the server's mirror of
      // this logic rather than re-derived per arm below.
      const active = turnIsActive(turn);
      switch (turn.state) {
        case "busy":
          return { status: "running", active };
        // A dialog is up and nothing moves until it is answered. Its own status,
        // never `ready`: the turn is still in flight, and the whole reason this
        // exists is that calling it finished both showed the wrong thing and let
        // auto-sleep kill a thread mid-question. Claude alone says this.
        case "waiting":
          return { status: "waiting", active, waitingFor: turn.waitingFor ?? null };
        // The agent takes input again, so the dot is `ready`, but a command it
        // started is still running and killing the PTY would take that with it.
        case "shell":
          return { status: "ready", active };
        case "idle":
          return { status: "ready", active };
      }
    }
  }
  // Otherwise the rows the agent is repainting. Level, not latched: the footer is
  // on screen or it is not. Nothing here can tell a question apart from a
  // finished turn, so this path only ever answers running or ready.
  const term = liveTerminal(t.id);
  if (!term) return null;
  const working = detectWorkingOnScreen(terminalScreenRows(term, LIVE_ROW_COUNT), iconKey);
  return { status: working ? "running" : "ready", active: working };
}

/**
 * What a thread becomes when nothing at all could be read about it, or null to
 * leave it alone.
 *
 * Only the two live statuses are demoted, and only once every activity stamp has
 * aged out: raw PTY bytes, a transcript write, or a pass that concluded the thread
 * was working. A thread with no stamp at all has nothing to measure from and is
 * demoted at once, which is what the server does with a missing anchor too.
 *
 * Exported for its test; the tick is the only caller.
 */
export function settleUnread(
  status: string | null | undefined,
  lastActivityAt: number,
  now: number,
): "ready" | null {
  if (status !== "running" && status !== "waiting") return null;
  if (lastActivityAt > 0 && now - lastActivityAt < UNREAD_TTL_MS) return null;
  return "ready";
}

function tick() {
  const now = Date.now();
  // Before anything writes into `prevStatus`, so a pass that follows a switch
  // starts with nothing to compare against rather than clearing halfway.
  dropStaleWorkspace();
  const visible = visibleThreadIds();
  // The one backend whose threads are judged here, handed to the poll so it asks
  // the machine the agents are actually running on, along with exactly which
  // threads are worth asking about. Collected while deciding and used at the end:
  // this pass reads the previous answer, which is at most one poll old.
  let sniffing: Backend | null = null;
  const queries: AgentTurnQuery[] = [];

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
      if (t.status === "ready" || t.status === "running" || t.status === "waiting") {
        app.setThreadStatus(t.id, "idle");
      }
      continue;
    }
    if (isFinished(t.status)) {
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
    if (iconKey && iconKey !== "terminal") {
      queries.push({
        kind: iconKey,
        sessionId: t.sessionId ?? null,
        cwd: threadCwd(t, app.projectById(t.projectId)) ?? "",
      });
    }
    const reading = read(t, iconKey);
    if (reading) {
      // Stamped from `active`, not from the dot: a thread waiting on a prompt, or
      // one whose agent finished while its shell runs on, is doing something even
      // though it is not the agent thinking. This stamp is what auto-sleep reads.
      if (reading.active) lastWorkingAt.set(t.id, now);
      const reason = reading.waitingFor?.trim();
      if (reading.status === "waiting" && reason) waitingReason.set(t.id, reason);
      else waitingReason.delete(t.id);
      const next = reading.status;
      if (t.status !== next) {
        app.setThreadStatus(t.id, next);
      }
      // The same call the control-event path makes for a thread this sweep is
      // not allowed to judge, so the two say the same things on the same terms.
      announceStatus(t, next);
    } else {
      // Nothing answered: no emulator holds this thread's rows and its agent
      // declares nothing. Left as it was, a `running` thread here would never be
      // revisited by anything, so it stays lit and, being lit, stays out of
      // auto-sleep's reach with its PTY held for the life of the window. Demoted
      // on the stamps alone, the way the server does it with no emulator either.
      // No notification: this is the absence of evidence, not a turn that ended.
      const settled = settleUnread(
        t.status,
        Math.max(
          lastWorkingAt.get(t.id) ?? 0,
          lastOutputAt.get(t.id) ?? 0,
          lastTranscriptAt.get(t.id) ?? 0,
        ),
        now,
      );
      if (settled) {
        app.setThreadStatus(t.id, settled);
        prevStatus.set(t.id, settled);
      }
    }

    // Only a settled `ready` is a candidate. `waiting` is excluded by being its
    // own status, and a `ready` thread whose shell is still running is excluded by
    // the activity stamp `maybeAutoClose` checks.
    if (t.status === "ready" && !visible.has(t.id)) {
      maybeAutoClose(t.id, t.iconKey);
    } else {
      idleSince.delete(t.id);
    }
  }

  if (sniffing) agentTurns.poll(sniffing, queries);
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
    // The sweep itself keeps its rate whether or not anybody is looking: what it
    // demotes are the threads nobody is looking at, and a notification is a
    // transition it has to be awake to see. The read behind it backs off
    // instead, and this is what makes coming back immediate rather than up to
    // POLL_MS_HIDDEN late.
    windowDocument()?.addEventListener("visibilitychange", onVisibility);
  },

  stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    windowDocument()?.removeEventListener("visibilitychange", onVisibility);
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
