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

class HomeStore {
  liveThreads: Thread[] = $derived(liveThreadsOf(app.threads));

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
