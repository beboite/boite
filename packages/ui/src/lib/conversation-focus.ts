import type { Client } from './client';
import { ATTENTION_RENEW_MS, PROTECTED_THREAD_LIMIT } from '@boite/contracts';

/** Focus belongs to the visible machine's socket, independently of its event subscriptions. */
export class ConversationFocus {
  private client: Client | null = null;
  private threadId: string | null = null;
  private protectedIds: string[] = [];
  private protectAll = false;
  private attentive = false;
  /** The core believes `attentive` for a lease only: say it again while it holds. */
  private renewal: ReturnType<typeof setInterval> | undefined;

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
    clearInterval(this.renewal);
    this.renewal = undefined;
    if (client?.state === 'ready') this.send(client, threadId, ids, protectAll, watching);
    if (watching) this.renewal = setInterval(() => {
      if (this.client?.state === 'ready') this.send(this.client, this.threadId, this.protectedIds, this.protectAll, true);
    }, ATTENTION_RENEW_MS);
  }

  private send(client: Client, threadId: string | null, protectedThreadIds: string[], protectAllThreads: boolean, attentive: boolean): void {
    // Preparation is optional on older cores; failure never blocks reading or sending.
    void client.call('threads.focus', { threadId, protectedThreadIds, protectAllThreads, ...(attentive ? { attentive } : {}) }).catch(() => undefined);
  }

  close(): void { this.update(null, null); }
}
