import type { Message, MessagePart, ToolDocument } from './index';

type ToolPart = Extract<MessagePart, { type: 'tool' }>;

/** Folded tools need their label and error preview, not megabytes of command output. */
export const TOOL_OUTPUT_INLINE_CHARS = 16 * 1024;
export const TOOL_OUTPUT_PREVIEW_CHARS = 1024;
/**
 * A tool input past this many serialized characters reaches a page as a
 * preview: a Write of a large file carries the whole file in its input, and
 * the card's line only needs the path or the command.
 */
export const TOOL_INPUT_INLINE_CHARS = 16 * 1024;
/** About how many serialized characters an input preview keeps. */
export const TOOL_INPUT_PREVIEW_CHARS = 4 * 1024;
/**
 * Tool documents past this many characters together stay on the core until
 * the card opens. A diff carries both whole texts of the file.
 */
export const TOOL_DOCUMENTS_INLINE_CHARS = 64 * 1024;

/**
 * Whether `value` holds more than `limit` characters of content, give or take
 * its punctuation. It stops as soon as it knows, so a 30 MB input costs the
 * first strings it meets, not a full `JSON.stringify`. Its JSON is at most six
 * UTF-8 bytes per character counted: `\u001f` is the longest escape.
 */
export function longerThan(value: unknown, limit: number): boolean {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === 'string') total += item.length + 2;
    // A number's JSON runs to 24 characters: -1.2345678901234567e-308.
    else if (item === null || typeof item !== 'object') total += 24;
    else if (Array.isArray(item)) { total += 2; for (const entry of item) stack.push(entry); }
    else for (const [key, entry] of Object.entries(item)) { total += key.length + 4; stack.push(entry); }
    if (total > limit) return true;
  }
  return false;
}

/**
 * The same shape cut to about `budget` serialized characters: each string to
 * its first characters, arrays and objects to their first entries. The card
 * reads its line (a path, a command, a pattern) from the start of the input.
 */
export function inputPreview(value: unknown, budget = TOOL_INPUT_PREVIEW_CHARS): unknown {
  let left = budget;
  const cut = (item: unknown, depth: number): unknown => {
    if (typeof item === 'string') {
      const keep = Math.max(0, Math.min(item.length, TOOL_OUTPUT_PREVIEW_CHARS, left));
      left -= keep + 2;
      // Flattened: a slice can keep the original megabytes alive in V8.
      return keep === item.length ? item : item.slice(0, keep).split('').join('');
    }
    if (item === null || typeof item !== 'object') { left -= 8; return item; }
    left -= 2;
    if (Array.isArray(item)) {
      const out: unknown[] = [];
      if (depth < 6) for (const entry of item) { if (left <= 0) break; out.push(cut(entry, depth + 1)); }
      return out;
    }
    const out: Record<string, unknown> = {};
    if (depth < 6) {
      for (const [key, entry] of Object.entries(item)) {
        if (left <= 0) break;
        left -= key.length + 4;
        out[key] = cut(entry, depth + 1);
      }
    }
    return out;
  };
  return cut(value, 0);
}

/** Characters of content the documents carry: texts and base64. */
function documentChars(documents: readonly ToolDocument[]): number {
  let total = 0;
  for (const doc of documents) {
    total += doc.kind === 'diff' ? doc.oldText.length + doc.newText.length + doc.path.length
      : doc.kind === 'markdown' ? doc.text.length : doc.data.length;
  }
  return total;
}

/** What a folded card shows of a document: its kind, path, title or caption, not its content. */
function documentStub(doc: ToolDocument): ToolDocument {
  if (doc.kind === 'diff') return { kind: 'diff', path: doc.path, oldText: '', newText: '' };
  if (doc.kind === 'markdown') return { kind: 'markdown', title: doc.title, text: '' };
  return { kind: 'image', mimeType: doc.mimeType, data: '', alt: doc.alt };
}

export interface ToolPreviewOptions {
  /** Inputs and documents too, for a client that sent `compactToolParts`. */
  inputs?: boolean;
  /** Defer every finished call's content whatever its size: the message is still too heavy. */
  strict?: boolean;
}

/**
 * One finished tool call as a page sends it: a long output as its preview,
 * and with `inputs` a long input as its preview and heavy documents as stubs.
 * `messages.toolPart` hands the whole call back when the card opens. A running
 * call stays whole: its output is still streaming.
 */
export function previewToolPart(part: ToolPart, options: ToolPreviewOptions = {}): ToolPart {
  if (part.status === 'running') return part;
  const strict = options.strict === true;
  let next = part;
  const output = part.output;
  if (!part.outputDeferred && output !== null && output.length > (strict ? TOOL_OUTPUT_PREVIEW_CHARS : TOOL_OUTPUT_INLINE_CHARS)) {
    // A slice can retain the original megabytes in V8. Flatten the bounded
    // preview before keeping it in a browser's reading cache.
    next = { ...next, output: output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS).split('').join(''), outputDeferred: true };
  }
  if (!options.inputs) return next;
  if (!part.inputDeferred && longerThan(part.input, strict ? TOOL_INPUT_PREVIEW_CHARS : TOOL_INPUT_INLINE_CHARS)) {
    next = { ...next, input: inputPreview(part.input), inputDeferred: true };
  }
  const documents = part.documents;
  if (!part.documentsDeferred && documents && documents.length > 0 && (strict ? documentChars(documents) > 0 : documentChars(documents) > TOOL_DOCUMENTS_INLINE_CHARS)) {
    next = { ...next, documents: documents.map(documentStub), documentsDeferred: true };
  }
  return next;
}

/** Project snapshots only: long outputs of finished calls as their preview. */
export function previewToolOutputs(messages: readonly Message[]): Message[] {
  return messages.map(message => {
    let changed = false;
    const parts = message.parts.map(part => {
      if (part.type !== 'tool') return part;
      const next = previewToolPart(part);
      if (next !== part) changed = true;
      return next;
    });
    return changed ? { ...message, parts } : message;
  });
}
