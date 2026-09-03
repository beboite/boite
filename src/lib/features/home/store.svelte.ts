import { app } from "$lib/app/store.svelte";
import { isDelegated } from "$lib/domain/delegation";
import { isSettled } from "$lib/domain/thread-settle";
import { approvals, type ApprovalItem } from "$lib/features/approvals/store.svelte";
import { openProjectDashboard } from "$lib/features/project/dashboard";
import { threadActivitySince } from "$lib/features/thread/activity.svelte";
import { relativeClock } from "$lib/shared/utils/clock.svelte";
import type { Thread } from "$lib/types";

/** A waiting thread lands in the inbox after this, not the moment a dialog appears. */
export const WAITING_INBOX_MS = 2 * 60 * 1000;

/** How long after the last orchestrator line the workspace counts as quiet. */
export const QUIET_ORCHESTRATOR_MS = 60 * 60 * 1000;

/** How many rows the "Recent" card holds. */
export const RECENT_THREAD_LIMIT = 10;

export type InboxItem =
  | { id: string; kind: "delegation"; thread: Thread }
  | { id: string; kind: "approval"; approval: ApprovalItem }
  | { id: string; kind: "waiting"; thread: Thread };

export function liveThreadsOf(threads: readonly Thread[]): Thread[] {
  return threads.filter((thread) => thread.status === "running" || thread.status === "waiting");
}

export function liveThreadCount(threads: readonly Thread[]): number {
  return liveThreadsOf(threads).length;
}

export function inboxOf(input: {
  threads: readonly Thread[];
  approvals: readonly ApprovalItem[];
  since: (threadId: string) => number | null;
  now: number;
}): InboxItem[] {
  const items: InboxItem[] = [];
  for (const thread of input.threads) {
    if (isDelegated(thread) && isSettled(thread)) {
      items.push({ id: `delegation:${thread.id}`, kind: "delegation", thread });
    }
  }
  for (const approval of input.approvals) {
    items.push({ id: `approval:${approval.id}`, kind: "approval", approval });
  }
  for (const thread of input.threads) {
    if (thread.status !== "waiting") continue;
    const started = input.since(thread.id) ?? thread.createdAt;
    if (input.now - started < WAITING_INBOX_MS) continue;
    items.push({ id: `waiting:${thread.id}`, kind: "waiting", thread });
  }
  return items;
}

/**
 * Nothing is happening in this workspace, so Home can be a launcher.
 *
 * Two readings, both required: no thread running or waiting, and the
 * orchestrator silent for an hour. A page that flipped on the thread list alone
 * would swap layout under a conversation someone is still reading.
 */
export function isQuiet(input: {
  threads: readonly Thread[];
  lastOrchestratorAt: number | null;
  now: number;
}): boolean {
  if (liveThreadsOf(input.threads).length > 0) return false;
  if (input.lastOrchestratorAt === null) return true;
  return input.now - input.lastOrchestratorAt >= QUIET_ORCHESTRATOR_MS;
}

/**
 * When a thread last did something, for the "Recent" ordering.
 *
 * `threadActivitySince` is the status engine's stamp and only exists for this
 * session; a settled thread falls back to when it was put away, and a row
 * nothing ever moved to its creation.
 */
export function threadRecency(
  thread: Thread,
  since: (threadId: string) => number | null,
): number {
  return since(thread.id) ?? thread.settledAt ?? thread.createdAt;
}

export function recentThreadsOf(input: {
  threads: readonly Thread[];
  since: (threadId: string) => number | null;
  limit?: number;
}): Thread[] {
  return [...input.threads]
    .sort((a, b) => threadRecency(b, input.since) - threadRecency(a, input.since))
    .slice(0, input.limit ?? RECENT_THREAD_LIMIT);
}

class HomeStore {
  liveThreads: Thread[] = $derived(liveThreadsOf(app.threads));

  /** The ten rows the launcher layout offers, newest first, every project. */
  recent: Thread[] = $derived.by(() =>
    recentThreadsOf({ threads: app.threads, since: threadActivitySince }),
  );

  inbox: InboxItem[] = $derived.by(() =>
    inboxOf({
      threads: app.threads,
      approvals: approvals.items,
      since: threadActivitySince,
      now: relativeClock.now,
    }),
  );
}

export const home = new HomeStore();

export function openHomeThread(threadId: string): void {
  const thread = app.threadById(threadId);
  if (!thread) return;
  app.selectedProjectId = thread.projectId;
  app.activeThreadId = thread.id;
  app.view = "terminal";
  app.mobileTab = "terminal";
}

export function goToHomeProject(): void {
  const id = app.selectedProjectId ?? app.sortedProjects[0]?.id;
  if (id) {
    openProjectDashboard(id);
    return;
  }
  app.view = "project";
  app.mobileTab = "terminal";
}
