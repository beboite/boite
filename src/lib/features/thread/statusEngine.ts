import { app } from "$lib/app/store.svelte";
import { workspace } from "$lib/backend";
import { settings } from "$lib/features/settings/store.svelte";
import { paneStore, leavesOf } from "$lib/features/panes/store.svelte";
import { parkedLocal } from "$lib/backend/tauri/parked";
import { notifyWhenUnfocused } from "$lib/storage/notify";
import { ptyKill } from "$lib/storage/pty";
import { logger } from "$lib/shared/services/logger.svelte";

const TICK_MS = 500;
const DEFAULT_WORKING_TTL_MS = 2000;

const lastWorkingAt = new Map<string, number>();
const workingTtlMs = new Map<string, number>();
const prevStatus = new Map<string, string>();
// Auto-sleep liveness, kept apart from lastWorkingAt so they never light the
// running/ready dot (a chatty plain shell or a just-finished agent would
// masquerade as working). They only veto the idle countdown:
//   lastOutputAt    — any raw PTY byte; an agent running a shell/subagent keeps
//                     emitting output even when its "esc to interrupt" footer
//                     scrolled out of the detect buffer.
//   lastTranscriptAt — the agent's session jsonl was written (a tool call, a
//                     subagent step, streamed tokens) while the terminal was
//                     visually quiet. Fed by the session monitor.
const lastOutputAt = new Map<string, number>();
const lastTranscriptAt = new Map<string, number>();
// Auto-sleep countdown anchors. Kept separate from lastWorkingAt: arming the
// countdown by stamping lastWorkingAt made tick() see a fresh "working"
// stamp, flipping hidden idle threads to running for 2s and firing a ghost
// "Ready for input" notification on the way back.
const idleSince = new Map<string, number>();
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function maybeAutoClose(threadId: string, iconKey: string | null | undefined) {
  if (!iconKey || iconKey === "terminal") return;
  const minutes = settings.state.idleTimeoutMinutes;
  if (!minutes || minutes <= 0) return;
  const enabled = settings.state.idleAutocloseByIcon[iconKey] === true;
  if (!enabled) return;
  const t = app.threads.find((x) => x.id === threadId);
  if (!t || !t.ptyId) return;
  if (t.keepAwake) return;
  if (!t.sessionId) {
    logger.debug("idle", `skip auto-sleep for ${t.label}: no session captured yet`, {
      iconKey,
    });
    return;
  }
  const now = Date.now();
  // Real recent activity vetoes the countdown: the agent's own working signal,
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

function tick() {
  const now = Date.now();
  const visible = visibleThreadIds();

  for (const t of app.threads) {
    // Server-owned threads (remote origin in dynamic mode) get their status
    // pushed as control events; ticking them would clobber it.
    if (!workspace.backendFor(t.origin).caps.clientStatus) continue;
    if (!t.ptyId) {
      // A parked local PTY is detached but still alive (workspace switch). Keep
      // its status + dot colour until the pane reattaches; demoting it to idle
      // would flatten the ping the user expects to stay lit.
      if (parkedLocal.has(t.id)) continue;
      lastWorkingAt.delete(t.id);
      lastOutputAt.delete(t.id);
      lastTranscriptAt.delete(t.id);
      workingTtlMs.delete(t.id);
      prevStatus.delete(t.id);
      idleSince.delete(t.id);
      if (t.status === "ready" || t.status === "running") {
        app.setThreadStatus(t.id, "idle");
      }
      continue;
    }
    if (t.status === "done" || t.status === "exited" || t.status === "error") {
      prevStatus.set(t.id, t.status);
      idleSince.delete(t.id);
      continue;
    }
    const stamp = lastWorkingAt.get(t.id) ?? 0;
    const ttl = workingTtlMs.get(t.id) ?? DEFAULT_WORKING_TTL_MS;
    const working = stamp > 0 && now - stamp < ttl;
    const next = working ? "running" : "ready";
    if (t.status !== next) {
      app.setThreadStatus(t.id, next);
    }
    if (prevStatus.get(t.id) === "running" && next === "ready") {
      const label = t.title ?? t.label;
      void notifyWhenUnfocused(label, "Ready for input");
    }
    prevStatus.set(t.id, next);

    if (next === "ready" && !visible.has(t.id)) {
      maybeAutoClose(t.id, t.iconKey);
    } else {
      idleSince.delete(t.id);
    }
  }
}

export const statusEngine = {
  markWorking(threadId: string, ttlMs = DEFAULT_WORKING_TTL_MS) {
    lastWorkingAt.set(threadId, Date.now());
    workingTtlMs.set(threadId, ttlMs);
  },

  // Raw PTY output and transcript writes only defer auto-sleep; they must not
  // touch lastWorkingAt or they would flip the dot to running.
  markOutput(threadId: string) {
    lastOutputAt.set(threadId, Date.now());
  },

  markTranscriptActive(threadId: string) {
    lastTranscriptAt.set(threadId, Date.now());
  },

  acquire() {
    refCount++;
    if (timer === null) {
      timer = setInterval(tick, TICK_MS);
    }
  },

  release(threadId: string) {
    refCount = Math.max(0, refCount - 1);
    lastWorkingAt.delete(threadId);
    lastOutputAt.delete(threadId);
    lastTranscriptAt.delete(threadId);
    workingTtlMs.delete(threadId);
    prevStatus.delete(threadId);
    idleSince.delete(threadId);
    if (refCount === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },
};
