import type { Message } from './index.ts';
import { longerThan } from './message-preview.ts';
import { utf8Bytes } from './transport.ts';

/**
 * A contiguous slice around the anchor, measured as the client receives it.
 * Drop the farthest edge until the two halves share one page budget. Keep a
 * single complete anchor even when it alone exceeds the page budget, just as
 * ordinary pages do. Callers preserve cursors for either edge that was cut.
 */
export function boundedMessageWindow(messages: Message[], anchorIndex: number, maxBytes: number): { start: number; end: number } {
  let start = 0, end = messages.length;
  // Every counted character costs at most six serialized UTF-8 bytes.
  if (!longerThan(messages, Math.floor(maxBytes / 6))) return { start, end };
  const sizes = messages.map(message => utf8Bytes(JSON.stringify(message)));
  let bytes = 2 + sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, end - 1);
  while (bytes > maxBytes && end - start > 1) {
    const older = anchorIndex - start;
    const newer = end - 1 - anchorIndex;
    const removed = older > newer ? start++ : --end;
    bytes -= sizes[removed]! + 1;
  }
  return { start, end };
}
