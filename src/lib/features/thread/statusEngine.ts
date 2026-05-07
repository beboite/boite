import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { paneStore, leavesOf } from "$lib/features/panes/store.svelte";
import { notifyWhenUnfocused } from "$lib/storage/notify";
import { saveThread } from "$lib/storage/db";
import { ptyKill } from "$lib/storage/pty";
import { logger } from "$lib/shared/services/logger.svelte";

const TICK_MS = 500;
const DEFAULT_WORKING_TTL_MS = 2000;

const lastWorkingAt = new Map<string, number>();
const workingTtlMs = new Map<string, number>();
const prevStatus = new Map<string, string>();
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
  const now = Date.now();
  const worked = lastWorkingAt.get(threadId);
  if (!worked) {
    lastWorkingAt.set(threadId, now);
    logger.debug("idle", `armed auto-sleep for ${t.label}`, {
      iconKey,
      timeoutMinutes: minutes,
    });
    return;
  }
  const idleMs = now - worked;
  if (idleMs < minutes * 60_000) return;
  const pid = t.ptyId;
  app.setThreadPtyId(t.id, null);
  app.setThreadStatus(t.id, "stopped", null);
  void saveThread({
    ...t,
    ptyId: null,
    status: "stopped",
    exitCode: null,
    args: [...t.args],
  }).catch((err) => {
    logger.warn("idle", `failed to persist auto-sleep for ${t.label}`, String(err));
  });
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
    if (!t.ptyId) {
      lastWorkingAt.delete(t.id);
      prevStatus.delete(t.id);
      if (t.status === "ready" || t.status === "running") {
        app.setThreadStatus(t.id, "idle");
      }
      continue;
    }
    if (t.status === "done" || t.status === "exited" || t.status === "error") {
      prevStatus.set(t.id, t.status);
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
    }
  }
}

export const statusEngine = {
  markWorking(threadId: string, ttlMs = DEFAULT_WORKING_TTL_MS) {
    lastWorkingAt.set(threadId, Date.now());
    workingTtlMs.set(threadId, ttlMs);
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
    workingTtlMs.delete(threadId);
    prevStatus.delete(threadId);
    if (refCount === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },
};
