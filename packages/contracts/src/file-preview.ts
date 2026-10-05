import type { Message } from './index';

/** The bytes a base64 string decodes to. */
function base64Bytes(data: string): number {
  return Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
}

/** File links need names and sizes. Preserve bytes for assistant media that previews on mount. */
export function previewFileData(messages: Message[]): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'file' || part.dataDeferred || (message.role !== 'user' && (/^(image|video|audio)\//.test(part.mimeType) || part.mimeType === 'application/pdf'))) return part;
      changed = true;
      return { ...part, data: '', bytes: base64Bytes(part.data), dataDeferred: true as const };
    });
    return changed ? { ...message, parts } : message;
  });
}

/** An image's data up to this many base64 characters stays in a page asked with `compactImages`. */
export const IMAGE_INLINE_CHARS = 8 * 1024;

/**
 * Large images of a page left on the core, as `previewFileData` leaves files:
 * the text paints first and the picture is read when it nears the screen.
 */
export function previewImageData(messages: Message[]): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'image' || part.dataDeferred || part.data.length <= IMAGE_INLINE_CHARS) return part;
      changed = true;
      return { ...part, data: '', bytes: base64Bytes(part.data), dataDeferred: true as const };
    });
    return changed ? { ...message, parts } : message;
  });
}
