import type { Message, Turn } from '@boite/contracts';
import { viewPart } from './inline-view';

/**
 * Files an agent publishes with `boite attach` land in the journal when it
 * runs the command, often in the middle of its answer. Once the turn ends the
 * chat draws them after everything else the turn wrote, so a capture is where
 * the reader stops instead of somewhere up the answer. A turn still running
 * shows them where they came, so a file is visible as soon as it is sent.
 */

/** A message `artifacts.publish` wrote: an assistant message that is one file and nothing else. */
export function publishedFile(message: Message): boolean {
  const part = message.parts[0];
  return message.role === 'assistant' && message.parts.length === 1 &&
    (part?.type === 'file' || (part?.type === 'artifact' && !part.view));
}

/**
 * `timeline` with each finished turn's published files moved after its last
 * other message, in the order they were published. Views are left for
 * `placeViews`, which then draws them after the files. A file whose turn has
 * nothing else here (the rest is on a page not loaded yet) keeps its place.
 * The same array comes back when nothing moves.
 */
export function filesLast(timeline: Message[], turns: readonly Pick<Turn, 'id' | 'status'>[]): Message[] {
  const live = new Set(turns.filter((turn) => turn.status === 'running' || turn.status === 'queued').map((turn) => turn.id));
  const lastOther = new Map<string, number>();
  timeline.forEach((message, index) => {
    if (!publishedFile(message) && !viewPart(message)) lastOther.set(message.turnId, index);
  });
  const moves = (message: Message, index: number) =>
    publishedFile(message) && !live.has(message.turnId) && (lastOther.get(message.turnId) ?? -1) > index;
  if (!timeline.some(moves)) return timeline;
  const held = new Map<number, Message[]>();
  const placed: Message[] = [];
  timeline.forEach((message, index) => {
    if (moves(message, index)) {
      const after = lastOther.get(message.turnId)!;
      held.set(after, [...(held.get(after) ?? []), message]);
      return;
    }
    placed.push(message, ...(held.get(index) ?? []));
  });
  return placed;
}
