import { FILE_ROUTE, type MessagePart, type RpcParams, type RpcResult } from '@boite/contracts';
import type { Core } from '../core';
import { invalidParams, notFound } from '../errors';
import { DISPLAY_TYPES, type DisplaySize } from '../media';

type Attachment = Extract<MessagePart, { type: 'file' | 'image' }>;

/**
 * With `display`, a picture comes as the WebP copy the timeline draws
 * (`MediaPreviews.display`), with `thumb` as the smaller one a thumbnail
 * draws. With `ticket`, the bytes come as a `FILE_ROUTE` path the client
 * fetches instead of base64 in the frame.
 */
export async function readMessageAttachment(core: Core, params: RpcParams<'messages.attachment'>): Promise<RpcResult<'messages.attachment'>> {
  const { threadId, messageId, partIndex } = params;
  const thread = core.threads.require(threadId);
  const permit = core.sharedAccess.publication(threadId, messageId);
  if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw invalidParams('messages.attachment.partIndex: expected a nonnegative integer', { field: 'partIndex', expected: 'a nonnegative integer' });
  // An incognito family leaves nothing behind, a browser's disk cache included.
  const parent = thread.parentThreadId ? core.journal.getThread(thread.parentThreadId) : null;
  const noStore = thread.incognito === true || parent?.incognito === true ? { noStore: true as const } : {};
  // The original is read only when no kept copy answers: it is often megabytes of base64.
  let read: Attachment | undefined;
  const original = (): Attachment => read ??= attachmentOf(core, threadId, messageId, partIndex);
  if (params.display === true) {
    const copy = await displayed(core, threadId, messageId, partIndex, params.thumb === true ? 'thumb' : 'large', original);
    permit?.check();
    if (copy !== null) {
      // A copy the journal could not keep has no bytes for the route to read: it comes in the frame.
      if (params.ticket !== true || !copy.kept) return { data: Buffer.from(copy.bytes).toString('base64'), mimeType: 'image/webp' };
      const size = copy.size;
      const ticket = core.fileTickets.mintBytes(`${threadId}:${messageId}:${partIndex}:${size}`, () => {
        permit?.check();
        const kept = core.media.kept(threadId, messageId, partIndex, size);
        return kept !== null && kept.length > 0 ? { data: kept, mime: 'image/webp', ...noStore, ...(permit ? {noStore: true as const} : {}) } : null;
      });
      return { data: '', url: `${FILE_ROUTE}/${ticket}`, mimeType: 'image/webp', bytes: copy.bytes.length };
    }
  }
  const part = original();
  if (params.ticket !== true) return { data: part.data };
  const ticket = core.fileTickets.mintBytes(`${threadId}:${messageId}:${partIndex}:original`, () => {
    permit?.check();
    let found: Attachment;
    try { found = attachmentOf(core, threadId, messageId, partIndex); } catch { return null; }
    return { data: Buffer.from(found.data, 'base64'), mime: found.mimeType, ...(found.type === 'file' && found.name ? { name: found.name } : {}), ...noStore, ...(permit ? {noStore: true as const} : {}) };
  });
  return { data: '', url: `${FILE_ROUTE}/${ticket}`, mimeType: part.mimeType, bytes: Buffer.byteLength(part.data, 'base64') };
}

function attachmentOf(core: Core, threadId: string, messageId: string, partIndex: number): Attachment {
  const found = core.journal.messagePart(messageId, partIndex);
  if (!found || found.message.threadId !== threadId) throw notFound(`message ${messageId} is not a message of thread ${threadId}`, { threadId, messageId });
  const part = found.part;
  if (part?.type !== 'file' && part?.type !== 'image') throw notFound(`part ${partIndex} is not an attachment of message ${messageId}`, { messageId, partIndex });
  return part;
}

/**
 * Which copy to send, its bytes and whether the journal keeps them, made when
 * missing, or null for the original. A thumbnail is made from the kept large
 * copy when there is one, so it never hydrates the original. One that would
 * not be lighter than its source gives way to that source: the kept large
 * copy, or else the original. A large copy that would not be lighter gives
 * way to the original.
 */
async function displayed(core: Core, threadId: string, messageId: string, partIndex: number, size: DisplaySize, original: () => Attachment): Promise<{ size: DisplaySize; bytes: Uint8Array; kept: boolean } | null> {
  const media = core.media;
  if (size === 'thumb') {
    const keptThumb = media.kept(threadId, messageId, partIndex, 'thumb');
    let thumb = keptThumb === null ? null : { data: keptThumb, kept: true };
    const large = media.kept(threadId, messageId, partIndex, 'large');
    if (thumb === null) {
      if (large !== null && large.length > 0) thumb = await media.display(threadId, messageId, partIndex, 'thumb', large);
      else {
        const part = original();
        if (!DISPLAY_TYPES.test(part.mimeType)) return null;
        thumb = await media.display(threadId, messageId, partIndex, 'thumb', part.data);
      }
    }
    if (thumb.data.length > 0) return { size: 'thumb', bytes: thumb.data, kept: thumb.kept };
    return large !== null && large.length > 0 ? { size: 'large', bytes: large, kept: true } : null;
  }
  const kept = media.kept(threadId, messageId, partIndex, 'large');
  let large = kept === null ? null : { data: kept, kept: true };
  if (large === null) {
    const part = original();
    if (!DISPLAY_TYPES.test(part.mimeType)) return null;
    large = await media.display(threadId, messageId, partIndex, 'large', part.data);
  }
  return large.data.length > 0 ? { size: 'large', bytes: large.data, kept: large.kept } : null;
}
