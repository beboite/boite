import type { Message, MessagePart, ToolDocument } from '@boite/contracts';

/** At most this many bytes of text and image data per kept timeline, counted as UTF-16. */
export const READING_CACHE_BYTES = 4 * 1024 * 1024;
export const READING_CACHE_MESSAGES = 2000;

function documentChars(document: ToolDocument): number {
  if (document.kind === 'diff') return document.oldText.length + document.newText.length;
  if (document.kind === 'markdown') return document.text.length;
  return document.data.length;
}

/** The characters a part holds, read from its strings rather than from a JSON copy of it. */
function partChars(part: MessagePart): number {
  switch (part.type) {
    case 'text':
      return part.text.length + (part.displayText?.length ?? 0);
    case 'thinking':
      return part.text.length;
    case 'image':
    case 'file':
      return part.data.length;
    case 'tool': {
      let chars = (part.output?.length ?? 0) + (part.inputText?.length ?? 0) + (JSON.stringify(part.input ?? null)?.length ?? 0);
      for (const document of part.documents ?? []) chars += documentChars(document);
      return chars;
    }
    default:
      return JSON.stringify(part).length;
  }
}

/**
 * Whether a timeline left behind is small enough to keep for a quick return.
 * It stops at the first message past the cap, and never walks a timeline with
 * too many messages to be kept anyway.
 */
export function fitsReadingCache(messages: readonly Message[]): boolean {
  if (messages.length > READING_CACHE_MESSAGES) return false;
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) chars += partChars(part);
    if (chars * 2 > READING_CACHE_BYTES) return false;
  }
  return true;
}
