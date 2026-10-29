import type { Message, MessagePart } from './index';
import { imageSize } from './image-size.ts';
import { decodedBytes } from './attachment-validation.ts';

/**
 * The blur a core holds for a deferred picture, by message and part, or null.
 * It is handed the bytes, so a core that has not made the blur yet can queue it.
 */
export type ImagePreviews = (messageId: string, partIndex: number, data: string) => string | null;

/** A picture a client draws in its box, and so can wait for, deferred with its size and blur. */
const DRAWN_IMAGE = /^image\/(png|jpeg|gif|webp)$/;

/**
 * File links need names and sizes. Video and audio bytes are fetched separately
 * when their player nears the screen. An assistant's PDF keeps its bytes for
 * signature checking before preview. An assistant's picture above
 * `IMAGE_INLINE_CHARS` is deferred like a prompt's, with the size its header
 * gives and its blur, and is read once it nears the screen: nine screenshots
 * an agent attached made a 40-message page weigh 12 MB.
 */
export function previewFileData(messages: Message[], previews?: ImagePreviews): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map((part, index) => {
      const next = previewFilePart(part, message.role, message.id, index, previews);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...message, parts } : message;
  });
}

/** One part as `previewFileData` leaves it, for a message of `role`; the same part when it stays whole. */
export function previewFilePart(part: MessagePart, role: Message['role'], messageId: string, index: number, previews?: ImagePreviews): MessagePart {
  if (part.type !== 'file' || part.dataDeferred) return part;
  const picture = DRAWN_IMAGE.test(part.mimeType);
  if (role !== 'user' && (picture ? part.data.length <= IMAGE_INLINE_CHARS : /^image\//.test(part.mimeType) || part.mimeType === 'application/pdf')) return part;
  const size = picture ? imageSize(part.data) : null;
  const preview = picture ? previews?.(messageId, index, part.data) ?? null : null;
  return {
    ...part, data: '', bytes: decodedBytes(part.data), dataDeferred: true as const,
    ...(size === null ? {} : size), ...(preview === null ? {} : { preview }),
  };
}

/** An image's data up to this many base64 characters stays in a page asked with `compactImages`. */
export const IMAGE_INLINE_CHARS = 8 * 1024;

/**
 * Large images of a page left on the core, as `previewFileData` leaves files:
 * the text paints first and the picture is read when it nears the screen. Each
 * keeps the size its header gives and, from a core that made one, its blur,
 * so the client draws its box before a byte of it arrives.
 */
export function previewImageData(messages: Message[], inline = IMAGE_INLINE_CHARS, previews?: ImagePreviews): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map((part, index) => {
      const next = previewImagePart(part, message.id, index, inline, previews);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...message, parts } : message;
  });
}

/** One part as `previewImageData` leaves it; the same part when it stays whole. */
export function previewImagePart(part: MessagePart, messageId: string, index: number, inline = IMAGE_INLINE_CHARS, previews?: ImagePreviews): MessagePart {
  if (part.type !== 'image' || part.dataDeferred || part.data.length <= inline) return part;
  const size = imageSize(part.data);
  const preview = previews?.(messageId, index, part.data) ?? null;
  return {
    ...part, data: '', bytes: decodedBytes(part.data), dataDeferred: true as const,
    ...(size === null ? {} : size), ...(preview === null ? {} : { preview }),
  };
}
