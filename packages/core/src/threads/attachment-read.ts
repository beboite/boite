import type { RpcParams } from '@boite/contracts';
import type { Core } from '../core';
import { invalidParams, notFound } from '../errors';

/** With `display`, a picture comes as the WebP copy the timeline draws (`MediaPreviews.display`). */
export async function readMessageAttachment(core: Core, params: RpcParams<'messages.attachment'>): Promise<{ data: string; mimeType?: string }> {
  core.threads.require(params.threadId);
  if (!Number.isSafeInteger(params.partIndex) || params.partIndex < 0) throw invalidParams('messages.attachment.partIndex: expected a nonnegative integer', { field: 'partIndex', expected: 'a nonnegative integer' });
  const found = core.journal.messagePart(params.messageId, params.partIndex);
  if (!found || found.message.threadId !== params.threadId) throw notFound(`message ${params.messageId} is not a message of thread ${params.threadId}`, { threadId: params.threadId, messageId: params.messageId });
  const part = found.part;
  if (part?.type !== 'file' && part?.type !== 'image') throw notFound(`part ${params.partIndex} is not an attachment of message ${params.messageId}`, { messageId: params.messageId, partIndex: params.partIndex });
  if (params.display === true) {
    const copy = await core.media.display(params.threadId, params.messageId, params.partIndex, part.mimeType, part.data);
    if (copy !== null) return copy;
  }
  return { data: part.data };
}
