import type { Message } from '@boite/contracts';
import { visibleAnswer, visibleUserText } from './message-display';

/** One occurrence of the query: in which message, and which one there, counting from 0. */
export interface FindHit {
  messageId: string;
  nth: number;
}

function occurrences(text: string, needle: string): number {
  if (!needle) return 0;
  const hay = text.toLowerCase();
  let count = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

/** What a message shows as text: the prompt, or the answer without its hidden markers. Tool cards are left out. */
function readable(message: Message): string {
  return message.parts
    .flatMap((part) => (part.type === 'text' ? [message.role === 'user' ? visibleUserText(part.text) : visibleAnswer(part.text)] : []))
    .join('\n');
}

/**
 * Every occurrence of `query` in the thread, oldest first, without case. It
 * reads the messages, not the page, so a match in a message the window has not
 * drawn is still counted and can be jumped to.
 */
export function findHits(messages: readonly Message[], query: string): FindHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return messages.flatMap((message) =>
    Array.from({ length: occurrences(readable(message), needle) }, (_, nth) => ({ messageId: message.id, nth }))
  );
}

/** The ranges of `query` in the text drawn under `root`, without case, in reading order. */
export function findRanges(root: Node, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

const ALL = 'boite-find';
const CURRENT = 'boite-find-current';

/** Paints the matches with the CSS highlight API, which leaves the DOM alone. A browser without it paints nothing. */
export function paintFind(all: Range[], current: Range | null): void {
  const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
  if (!registry || typeof Highlight === 'undefined') return;
  registry.set(ALL, new Highlight(...all));
  if (current) registry.set(CURRENT, new Highlight(current));
  else registry.delete(CURRENT);
}

export function clearFind(): void {
  const registry = typeof CSS !== 'undefined' && 'highlights' in CSS ? CSS.highlights : null;
  registry?.delete(ALL);
  registry?.delete(CURRENT);
}
