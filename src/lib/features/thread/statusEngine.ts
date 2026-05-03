import { app } from "$lib/app/store.svelte";
import { settings } from "$lib/features/settings/store.svelte";
import { notifyWhenUnfocused } from "$lib/storage/notify";
import { ptyKill } from "$lib/storage/pty";
import { logger } from "$lib/shared/services/logger.svelte";

const TICK_MS = 500;
const WORKING_TTL_MS = 2000;

const lastWorkingAt = new Map<string, number>();
const lastViewedAt = new Map<string, number>();
const prevStatus = new Map<string, string>();
let timer: ReturnType<typeof setInterval> | null = null;
let refCount = 0;

function maybeAutoClose(threadId: string, iconKey: string | null | undefined) {
  if (!iconKey) return;
  const minutes = settings.state.idleTimeoutMinutes;
  if (!minutes || minutes <= 0) return;
  const enabled = settings.state.idleAutocloseByIcon[iconKey];
  if (!enabled) return;
  const viewed = lastViewedAt.get(threadId);
  if (!viewed) return;
  if (Date.now() - viewed < minutes * 60_000) return;
  const t = app.threads.find((x) => x.id === threadId);
  if (!t || !t.ptyId) return;
  const pid = t.ptyId;
  void ptyKill(pid).catch(() => {});
  logger.info("idle", `auto-closed ${t.label} after ${minutes}m idle`, {
    iconKey,
  });
}

function tick() {
  const now = Date.now();
  for (const t of app.threads) {
    if (t.status === "done" || t.status === "exited" || t.status === "error") {
      prevStatus.set(t.id, t.status);
      continue;
    }
    const stamp = lastWorkingAt.get(t.id) ?? 0;
    const working = stamp > 0 && now - stamp < WORKING_TTL_MS;
    const next = working ? "running" : "ready";
    if (t.status !== next) {
      app.setThreadStatus(t.id, next);
    }
    if (prevStatus.get(t.id) === "running" && next === "ready") {
      const label = t.title ?? t.label;
      void notifyWhenUnfocused(label, "Ready for input");
    }
    prevStatus.set(t.id, next);

    if (next === "ready" && t.id !== app.activeThreadId) {
      maybeAutoClose(t.id, t.iconKey);
    }
  }
}

export const statusEngine = {
  markWorking(threadId: string) {
    lastWorkingAt.set(threadId, Date.now());
  },

  markViewed(threadId: string) {
    lastViewedAt.set(threadId, Date.now());
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
    lastViewedAt.delete(threadId);
    prevStatus.delete(threadId);
    if (refCount === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  },
};
