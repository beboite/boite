import type { Client } from './client';
import { ATTENTION_ACTIVITY_MS, ATTENTION_RENEW_MS, PROTECTED_THREAD_LIMIT } from '@boite/contracts';

/** Focus belongs to the visible machine's socket, independently of its event subscriptions. */
export class ConversationFocus {
  private client: Client | null = null;
  private threadId: string | null = null;
  private protectedIds: string[] = [];
  private protectAll = false;
  private attentive = false;
  /** The core believes `attentive` for a lease only: say it again while it holds. */
  private renewal: ReturnType<typeof setInterval> | undefined;
  /** When the user last used the page while attentive (`watchAttention`), and the value the core last heard. */
  private activeAt: number | null = null;
  private reportedActiveAt: number | null = null;

  update(client: Client | null, threadId: string | null, protectedThreadIds: readonly string[] = [], protectAllThreads = false, attentive = false): void {
    const protectAll = protectAllThreads || protectedThreadIds.length > PROTECTED_THREAD_LIMIT;
    const ids = protectAll ? [] : [...new Set(protectedThreadIds)].sort();
    const watching = attentive && threadId !== null;
    if (client === this.client && threadId === this.threadId && protectAll === this.protectAll && watching === this.attentive && ids.length === this.protectedIds.length && ids.every((id, i) => id === this.protectedIds[i])) return;
    if (this.client && this.client !== client && this.client.state === 'ready') {
      this.send(this.client, null, [], false, false);
    }
    this.client = client;
    this.threadId = threadId;
    this.protectedIds = ids;
    this.protectAll = protectAll;
    this.attentive = watching;
    this.report();
  }

  /**
   * The user used the page while attentive. The first use after a quiet spell
   * is said at once: it tells the core that news on this thread was seen, and
   * the push held back for it can go. Later uses ride on the renewals.
   */
  activity(at: number): void {
    this.activeAt = at;
    if (this.attentive && (this.reportedActiveAt === null || at - this.reportedActiveAt >= ATTENTION_ACTIVITY_MS)) this.report();
  }

  private report(): void {
    clearInterval(this.renewal);
    this.renewal = undefined;
    if (this.client?.state === 'ready') this.send(this.client, this.threadId, this.protectedIds, this.protectAll, this.attentive);
    if (this.attentive) this.renewal = setInterval(() => {
      if (this.client?.state === 'ready') this.send(this.client, this.threadId, this.protectedIds, this.protectAll, true);
    }, ATTENTION_RENEW_MS);
  }

  private send(client: Client, threadId: string | null, protectedThreadIds: string[], protectAllThreads: boolean, attentive: boolean): void {
    const idle = threadId !== null && this.activeAt !== null ? { idleMs: Math.max(0, Date.now() - this.activeAt) } : {};
    if (threadId !== null) this.reportedActiveAt = this.activeAt;
    // Preparation is optional on older cores; failure never blocks reading or sending.
    void client.call('threads.focus', { threadId, protectedThreadIds, protectAllThreads, ...(attentive ? { attentive } : {}), ...idle }).catch(() => undefined);
  }

  close(): void { this.update(null, null); }
}
