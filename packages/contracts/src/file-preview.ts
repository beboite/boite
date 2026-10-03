import type { Message } from './index';

/** File links need names and sizes. Preserve bytes for assistant media that previews on mount. */
export function previewFileData(messages: Message[]): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'file' || part.dataDeferred || (message.role !== 'user' && (/^(image|video|audio)\//.test(part.mimeType) || part.mimeType === 'application/pdf'))) return part;
      changed = true;
      const bytes = Math.floor(part.data.length * 3 / 4) - (part.data.endsWith('==') ? 2 : part.data.endsWith('=') ? 1 : 0);
      return { ...part, data: '', bytes, dataDeferred: true as const };
    });
    return changed ? { ...message, parts } : message;
  });
}
