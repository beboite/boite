import type { Client } from './client';

/** Focus belongs to the visible machine's socket, independently of its event subscriptions. */
export class ConversationFocus {
  private client: Client | null = null;
  private threadId: string | null = null;

  update(client: Client | null, threadId: string | null): void {
    if (client === this.client && threadId === this.threadId) return;
    if (this.client && this.client !== client && this.client.state === 'ready' && this.threadId !== null) {
      this.send(this.client, null);
    }
    this.client = client;
    this.threadId = threadId;
    if (client?.state === 'ready') this.send(client, threadId);
  }

  private send(client: Client, threadId: string | null): void {
    // Preparation is optional on older cores; failure never blocks reading or sending.
    void client.call('threads.focus', { threadId }).catch(() => undefined);
  }

  close(): void { this.update(null, null); }
}
