import type { Message, MessagePart } from './index';
import { previewFileData, previewImageData } from './file-preview.ts';
import { longerThan, previewToolPart } from './message-preview.ts';

/** What a client asks a page, and its live events, to leave on the core until it is looked at. */
export interface TransportOptions {
  /** Long outputs of finished tool calls. */
  compactTools?: boolean;
  /** Files of a page, read with `messages.attachment`. */
  compactFiles?: boolean;
  /** Large images, read with `messages.attachment`. */
  compactImages?: boolean;
  /**
   * Long tool inputs and heavy tool documents too, read with
   * `messages.toolPart`. Past `MESSAGE_SENT_MAX_BYTES` a message is cut
   * further, so no single message can keep a thread from opening.
   */
  compactToolParts?: boolean;
}

/**
 * The most serialized UTF-8 bytes one message may weigh in a page asked with
 * `compactToolParts`. Past it every finished tool call and image the client
 * can fetch back is deferred, then the longest texts are cut and say how much
 * (`omitted`). Half the RPC frame: the page's other messages and the
 * snapshot's turns travel in the same answer.
 */
export const MESSAGE_SENT_MAX_BYTES = 8 * 1024 * 1024;

/** Whether the options defer anything at all. */
function compacts(options: TransportOptions): boolean {
  return !!(options.compactTools || options.compactFiles || options.compactImages || options.compactToolParts);
}

function toolParts(message: Message, options: { inputs: boolean; strict: boolean }): Message {
  let changed = false;
  const parts = message.parts.map(part => {
    if (part.type !== 'tool') return part;
    const next = previewToolPart(part, options);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? { ...message, parts } : message;
}

function project(message: Message, options: TransportOptions, strict: boolean): Message {
  const tools = options.compactTools || options.compactToolParts
    ? toolParts(message, { inputs: !!options.compactToolParts, strict }) : message;
  const files = options.compactFiles ? previewFileData([tools])[0]! : tools;
  return options.compactImages ? previewImageData([files], strict ? 0 : undefined)[0]! : files;
}

/** UTF-8 bytes of `text`, counted without encoding it. A lone surrogate counts as the three bytes of U+FFFD. */
export function utf8Bytes(text: string): number {
  let bytes = text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) continue;
    if (code < 0x800) bytes += 1;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00) { bytes += 2; index++; }
    else bytes += 2;
  }
  return bytes;
}

/**
 * The message's JSON in UTF-8 bytes when it may reach `max`, else 0. A walk
 * that stops early clears almost every message; only one holding over a sixth
 * of `max` in content is serialized and counted.
 */
function heavyBytes(message: Message, max: number): number {
  if (!longerThan(message, Math.floor(max / 6))) return 0;
  const text = JSON.stringify(message);
  return text.length * 3 < max ? 0 : utf8Bytes(text);
}

/**
 * The longest texts of the message cut until it fits `max`, each with the
 * count of characters it lost in `omitted`. Only reached by a message that is
 * still too heavy once everything fetchable was deferred.
 */
function cutTexts(message: Message, bytes: number, max: number): Message {
  let excess = bytes - max + 64 * 1024;
  const parts: MessagePart[] = [...message.parts];
  const order = parts
    .map((part, index) => ({ index, length: part.type === 'text' || part.type === 'thinking' ? part.text.length : 0 }))
    .filter(entry => entry.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const { index } of order) {
    if (excess <= 0) break;
    const part = parts[index]!;
    if (part.type !== 'text' && part.type !== 'thinking') continue;
    // Back from the end by code point, counting UTF-8 bytes: the JSON escapes
    // of what goes only make the cut more generous.
    let keep = part.text.length, removed = 0;
    while (keep > 0 && removed < excess) {
      const code = part.text.charCodeAt(keep - 1);
      const pair = keep > 1 && (code & 0xfc00) === 0xdc00 && (part.text.charCodeAt(keep - 2) & 0xfc00) === 0xd800;
      keep -= pair ? 2 : 1;
      removed += pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }
    excess -= removed;
    const text = part.text.slice(0, keep);
    const omitted = (part.omitted ?? 0) + part.text.length - keep;
    if (part.type === 'thinking') parts[index] = { ...part, text, omitted };
    else {
      const { displayText, ...rest } = part;
      parts[index] = { ...rest, text, omitted, ...(displayText !== undefined && displayText.length <= keep ? { displayText } : {}) };
    }
  }
  return { ...message, parts };
}

/**
 * One message as a client receives it for these options. With
 * `compactToolParts`, a message still over `MESSAGE_SENT_MAX_BYTES` defers
 * every finished call and image it holds, then cuts its longest texts. Each
 * shape is measured once.
 */
export function projectMessage(message: Message, options: TransportOptions): Message {
  const light = project(message, options, false);
  if (!options.compactToolParts) return light;
  const max = MESSAGE_SENT_MAX_BYTES;
  const lightBytes = heavyBytes(light, max);
  if (lightBytes < max) return light;
  const strict = project(message, options, true);
  const strictBytes = strict === light ? lightBytes : heavyBytes(strict, max);
  return strictBytes < max ? strict : cutTexts(strict, strictBytes, max);
}

/** The messages a client receives for these options. */
export function forTransport(messages: Message[], options: TransportOptions): Message[] {
  if (!compacts(options)) return messages;
  return messages.map(message => projectMessage(message, options));
}
