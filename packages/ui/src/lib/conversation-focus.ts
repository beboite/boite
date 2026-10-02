import type { Client } from './client';
import { PROTECTED_THREAD_LIMIT } from '@boite/contracts';

/** Focus belongs to the visible machine's socket, independently of its event subscriptions. */
export class ConversationFocus {
  private client: Client | null = null;
  private threadId: string | null = null;
  private protectedIds: string[] = [];
  private protectAll = false;

  update(client: Client | null, threadId: string | null, protectedThreadIds: readonly string[] = [], protectAllThreads = false): void {
    const protectAll = protectAllThreads || protectedThreadIds.length > PROTECTED_THREAD_LIMIT;
    const ids = protectAll ? [] : [...new Set(protectedThreadIds)].sort();
    if (client === this.client && threadId === this.threadId && protectAll === this.protectAll && ids.length === this.protectedIds.length && ids.every((id, i) => id === this.protectedIds[i])) return;
    if (this.client && this.client !== client && this.client.state === 'ready') {
      this.send(this.client, null, [], false);
    }
    this.client = client;
    this.threadId = threadId;
    this.protectedIds = ids;
    this.protectAll = protectAll;
    if (client?.state === 'ready') this.send(client, threadId, ids, protectAll);
  }

  private send(client: Client, threadId: string | null, protectedThreadIds: string[], protectAllThreads: boolean): void {
    // Preparation is optional on older cores; failure never blocks reading or sending.
    void client.call('threads.focus', { threadId, protectedThreadIds, protectAllThreads }).catch(() => undefined);
  }

  close(): void { this.update(null, null); }
}
