import { RpcErrorCode, type Message, type MessageId, type Thread, type ThreadId } from '@boite/contracts';
import { RpcFailure } from '../client';
import { strings } from '../strings';
import type { ToolPart } from '../tool-groups';
import type { StoreContext } from './context';
import { fullMessage } from './full-message';

/** Where a fetched part lands: every copy of the thread the client holds. */
interface Snapshots {
  threadSnapshots(threadId: ThreadId): Thread[];
  messages(threadId: ThreadId, messageId: string): Message[];
}

/**
 * What a page leaves folded on the core until the reader opens it: a call's
 * output (its input and documents too on a core with `deferredToolParts`) and
 * an attachment's bytes. Duplicate requests share one fetch. Refreshing a
 * visit keeps what it opened; leaving the thread (`leave`) drops what the old
 * visit still waits for.
 */
export class DeferredParts {
  #visit = 0;

  constructor(private readonly ctx: StoreContext, private readonly threads: Snapshots) {}

  leave(): void { this.#visit++; }

  readonly #toolOutputs = new Map<string, { client: NonNullable<StoreContext['client']>; generation: number; promise: Promise<void> }>();
  /**
   * Hydrate only a card the reader opened, shared by duplicate requests: its
   * output, and on a core with `deferredToolParts` its input and documents.
   */
  toolOutput(threadId: ThreadId, messageId: MessageId, toolId: string): Promise<void> {
    const key = JSON.stringify([threadId, messageId, toolId]);
    const client = this.ctx.client;
    if (!client) return Promise.reject(new Error(strings.connection.unavailable));
    const generation = this.#visit;
    const held = this.#toolOutputs.get(key);
    if (held?.client === client && held.generation === generation) return held.promise;
    const whole = this.ctx.store.core?.features?.deferredToolParts === true;
    const read = whole
      ? client.call('messages.toolPart', { threadId, messageId, toolId }).then(({ part }) => part as Partial<ToolPart>)
      : client.call('messages.toolOutput', { threadId, messageId, toolId }).then(({ output }): Partial<ToolPart> => ({ output }));
    const loading = read.catch(async (error): Promise<Partial<ToolPart> | null> => {
      if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.MethodNotFound) throw error;
      if (this.ctx.client !== client || generation !== this.#visit) return null;
      const message = await fullMessage(client, this.threads.threadSnapshots(threadId), threadId, messageId, () => this.ctx.client === client && generation === this.#visit);
      // A visit left during the walk is not a missing tool: nobody shows that card any more.
      if (this.ctx.client !== client || generation !== this.#visit) return null;
      const part = message?.parts.find(part => part.type === 'tool' && part.toolId === toolId);
      if (part?.type !== 'tool') throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `tool ${toolId} is not a tool of message ${messageId}` });
      return part;
    }).then(full => {
      if (!full || this.ctx.client !== client || generation !== this.#visit) return;
      for (const message of this.threads.messages(threadId, messageId)) {
        for (const part of message.parts) {
          if (part.type !== 'tool' || part.toolId !== toolId) continue;
          if (part.outputDeferred && full.output !== undefined) { part.output = full.output; delete part.outputDeferred; }
          if (part.inputDeferred && 'input' in full) { part.input = full.input; delete part.inputDeferred; }
          if (part.documentsDeferred && full.documents !== undefined) { part.documents = full.documents; delete part.documentsDeferred; }
        }
      }
    }).finally(() => { if (this.#toolOutputs.get(key)?.promise === loading) this.#toolOutputs.delete(key); });
    this.#toolOutputs.set(key, { client, generation, promise: loading });
    return loading;
  }

  readonly #attachments = new Map<string, { client: NonNullable<StoreContext['client']>; visit: number; promise: Promise<string | null> }>();

  /** Share duplicate downloads; null cancels a visit that no longer wants the bytes. */
  attachment(threadId: ThreadId, messageId: string, partIndex: number): Promise<string | null> {
    const client = this.ctx.client;
    if (!client) return Promise.reject(new Error(strings.connection.unavailable));
    const visit = this.#visit, generation = this.ctx.clientGeneration;
    const key = JSON.stringify([threadId, messageId, partIndex]);
    const held = this.#attachments.get(key);
    if (held?.client === client && held.visit === visit) return held.promise;
    const promise = client.call('messages.attachment', { threadId, messageId, partIndex }).catch(async error => {
      if (!(error instanceof RpcFailure) || error.code !== RpcErrorCode.MethodNotFound) throw error;
      const message = await fullMessage(client, this.threads.threadSnapshots(threadId), threadId, messageId, () => this.ctx.client === client && visit === this.#visit);
      // Leaving during the fallback walk cancels the download, just like a tool disclosure.
      if (!this.ctx.currentClient(client, generation) || visit !== this.#visit) return null;
      const part = message?.parts[partIndex];
      if (part?.type !== 'file' && part?.type !== 'image') throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `part ${partIndex} is not an attachment of message ${messageId}` });
      return { data: part.data };
    }).then(full => {
      if (!full || !this.ctx.currentClient(client, generation) || this.#visit !== visit) return null;
      const { data } = full;
      for (const message of this.threads.messages(threadId, messageId)) {
        const part = message.parts[partIndex];
        if ((part?.type === 'file' || part?.type === 'image') && part.dataDeferred) { part.data = data; delete part.dataDeferred; }
      }
      return data;
    }).finally(() => { if (this.#attachments.get(key)?.promise === promise) this.#attachments.delete(key); });
    this.#attachments.set(key, { client, visit, promise });
    return promise;
  }
}
