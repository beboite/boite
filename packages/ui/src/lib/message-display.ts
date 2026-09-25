import type { Message, MessagePart } from '@boite/contracts';

/** Older cores journalled the whole goal instruction as a user message. */
export function visibleUserText(text: string): string {
  const legacy = /^Work toward this goal: ([\s\S]*?)\r?\nContinue until the objective is achieved\./.exec(text);
  return legacy ? `/goal ${legacy[1]}` : text;
}

/** Hide protocol-only lines, including a marker that is still streaming. */
export function visibleAnswer(text: string): string {
  // Only the last line that is not blank can hold the marker, so the regex reads
  // from the break before it rather than trying every offset of the answer.
  const from = Math.max(0, text.trimEnd().lastIndexOf('\n'));
  const tail = /(?:^|\n)([\t ]*\[BOITE[^\r\n]*?)[\t ]*(?:\r?\n[\t ]*)*$/.exec(text.slice(from));
  if (!tail) return text;
  const marker = tail[1]!.trim();
  if (!['[BOITE_GOAL_COMPLETE]', '[BOITE_GOAL_BLOCKED]'].some(value => value.startsWith(marker))) return text;
  const index = from + tail.index;
  const start = index + (text[index] === '\n' ? 1 : 0);
  // A terminal marker inside an unfinished fenced example is still answer content.
  let fence: string | null = null;
  for (const line of text.slice(0, start).split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const delimiter = match[1]!;
    if (!fence) fence = delimiter;
    else if (delimiter[0] === fence[0] && delimiter.length >= fence.length && !match[2]!.trim()) fence = null;
  }
  return fence ? text : text.slice(0, start);
}

export function messagePreview(message: Message): string {
  return message.parts.filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text').map(part => promptText(part)).join(' ').trim();
}

export function promptText(part: Extract<MessagePart, { type: 'text' }>): string {
  return part.displayText ?? visibleUserText(part.text);
}

export interface PromptSegment {
  text: string;
  kind: 'plain' | 'command' | 'ultrathink' | 'ultracode';
}

/**
 * The words Claude Code acts on anywhere in a prompt: `ultrathink` asks for the
 * deepest thinking on that turn, `ultracode` opts the turn into the Workflow
 * tool. Other harnesses read them as plain words.
 */
const PROMPT_KEYWORDS = /\b(ultrathink|ultracode)\b/gi;

/**
 * Whether the keywords do anything: Claude Code has to run the turn, and on a
 * Claude model. A `claude-sdk` descriptor routed to another model, or a Claude
 * model behind another harness, reads them as plain words. No model is the
 * CLI's own default, a Claude one.
 */
export function claudeKeywords(protocol: string | undefined, model: string | null | undefined): boolean {
  if (protocol !== 'claude-sdk') return false;
  return model == null || /^(claude|opus|sonnet|haiku|fable|default)(?![a-z0-9])/i.test(model);
}

/** A prompt cut where it is drawn differently: the command it opens with, then each keyword. */
export function promptSegments(text: string, command: string | undefined, keywords: boolean): PromptSegment[] {
  const segments: PromptSegment[] = [];
  const start = command && text.startsWith(command) ? command.length : 0;
  if (start > 0) segments.push({ text: command!, kind: 'command' });
  let at = start;
  if (keywords) {
    for (const match of text.slice(start).matchAll(PROMPT_KEYWORDS)) {
      const index = start + match.index;
      if (index > at) segments.push({ text: text.slice(at, index), kind: 'plain' });
      segments.push({ text: match[0], kind: match[0].toLowerCase() as 'ultrathink' | 'ultracode' });
      at = index + match[0].length;
    }
  }
  if (at < text.length) segments.push({ text: text.slice(at), kind: 'plain' });
  return segments;
}

/**
 * The segments that fall in `[start, end)` of the prompt they were cut from, so
 * a piece of the prompt keeps the keyword boundaries of the whole.
 */
export function sliceSegments(segments: PromptSegment[], start: number, end: number): PromptSegment[] {
  const slice: PromptSegment[] = [];
  let at = 0;
  for (const segment of segments) {
    const from = Math.max(at, start);
    const to = Math.min(at + segment.text.length, end);
    if (from < to) slice.push({ text: segment.text.slice(from - at, to - at), kind: segment.kind });
    at += segment.text.length;
  }
  return slice;
}

/** The Boite command a prompt opens with, drawn in the accent wherever the prompt is shown. */
export function promptCommand(text: string): string | undefined {
  return /^\/(goal|loop)(?=\s|$)/.exec(text)?.[0];
}

export function answerText(text: string, _live: boolean): string {
  return visibleAnswer(text);
}

/** Only complete paragraphs and fenced blocks enter the timeline while streaming. */
export function paragraphBlocks(text: string, live: boolean): string[] {
  return new ParagraphScan().blocks(text, live);
}

/**
 * paragraphBlocks for a text that grows: a new text that extends the last one
 * resumes at the last complete line, so a delta reads only its own lines. The
 * same array comes back until a paragraph completes. Only complete lines are
 * read, because an unfinished line can open a fence but never close a block.
 */
export class ParagraphScan {
  #read = '';
  #start = 0;
  #fence = '';
  #done: string[] = [];
  #tail = '';
  #result: string[] | null = null;

  blocks(text: string, live: boolean): string[] {
    if (!text.startsWith(this.#read)) {
      this.#read = '';
      this.#start = 0;
      this.#fence = '';
      this.#done = [];
      this.#result = null;
    }
    let offset = this.#read.length;
    let grew = false;
    for (let end = text.indexOf('\n', offset); end !== -1; end = text.indexOf('\n', offset)) {
      const trimmed = text.slice(offset, end + 1).trim();
      offset = end + 1;
      const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0];
      if (marker) {
        if (!this.#fence) this.#fence = marker;
        else if (marker[0] === this.#fence[0] && marker.length >= this.#fence.length && trimmed === marker) this.#fence = '';
      }
      if (!this.#fence && !trimmed) {
        const block = text.slice(this.#start, offset).trim();
        if (block) { this.#done.push(block); grew = true; }
        this.#start = offset;
      }
    }
    this.#read = text.slice(0, offset);
    const tail = live ? '' : text.slice(this.#start).trim();
    if (this.#result && !grew && tail === this.#tail) return this.#result;
    this.#tail = tail;
    this.#result = tail ? [...this.#done, tail] : [...this.#done];
    return this.#result;
  }
}

/** Codex can append several bold thought headings inside the same part. */
export function currentThought(text: string): { title: string | null; text: string } {
  const headings = [...text.matchAll(/^[\t ]*\*\*([^*\r\n]+)\*\*[\t ]*\r?$/gm)];
  const last = headings.at(-1);
  return { title: last?.[1]?.trim() ?? null, text: last ? text.slice(last.index) : text };
}
