import type { Message } from './index.ts';
import { utf8Bytes } from './transport.ts';

/**
 * A contiguous slice around the anchor, measured as the client receives it.
 * Drop the farthest edge until the two halves share one page's byte and
 * message budgets. Keep a single complete anchor even when it alone exceeds
 * the page budget, as ordinary pages do. Callers provide the index of an
 * existing anchor and preserve cursors for either edge that was cut.
 */
export function boundedMessageWindow(messages: Message[], anchorIndex: number, maxBytes: number, maxMessages: number): { start: number; end: number } {
  let start = 0, end = messages.length;
  const sizes = messages.map(message => utf8Bytes(JSON.stringify(message)));
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, end - 1);
  while ((bytes > maxBytes || end - start > maxMessages) && end - start > 1) {
    const older = anchorIndex - start;
    const newer = end - 1 - anchorIndex;
    const removed = older > newer ? start++ : --end;
    // Removing an edge from at least two messages removes exactly one comma.
    bytes -= sizes[removed]! + 1;
  }
  return { start, end };
}
