import type { MemoryEvent, Message, MessagePart } from '@boite/contracts';
import { partRuns, runKey, type PartRun } from './tool-groups';

/** Older notices use tool timestamps; new notices retain their exact part boundary. */
export function placeMemoryEvents(messages: Message[], events: MemoryEvent[]) {
  const inline = new Map<string, MemoryEvent[]>();
  const standalone: MemoryEvent[] = [];
  for (const event of events) {
    let anchor = event.anchor;
    if (!anchor) {
      const message = messages.findLast(message => message.createdAt <= event.at);
      if (message?.role === 'assistant') {
        const index = message.parts.findLastIndex(part => part.type === 'tool' && part.startedAt !== undefined && part.startedAt <= event.at);
        if (index >= 0) anchor = { messageId: message.id, partIndex: index + 1 };
      }
    }
    if (!anchor) { standalone.push(event); continue; }
    // An anchored message on an older page must not leave its notice at the tail.
    if (!messages.some(message => message.id === anchor.messageId)) continue;
    const group = inline.get(anchor.messageId) ?? [];
    group.push({ ...event, anchor });
    inline.set(anchor.messageId, group);
  }
  return { inline, standalone };
}

type MemoryRun = { kind: 'memory'; key: string; events: MemoryEvent[] };

/** What a notice card says: the kind, a stop's reason and the limit it crossed. */
function noticeKey(event: MemoryEvent): string {
  if (event.kind === 'killed') return `killed:${event.reason}:${event.limitBytes}`;
  return event.kind === 'throttled' ? `throttled:${event.limitBytes}` : event.kind;
}

/** Back-to-back notices that would read the same become one card, whatever time passed between them. */
export const sameNotice = (before: MemoryEvent | undefined, event: MemoryEvent): boolean =>
  before !== undefined && noticeKey(before) === noticeKey(event);

/**
 * Folds each standalone notice row that directly follows another into it:
 * `rows` is the sorted timeline, `notices` the event behind each notice row.
 * Returns the timeline without the folded rows and the events each kept row shows.
 */
export function mergeNoticeRows(rows: Message[], notices: ReadonlyMap<string, MemoryEvent>): { rows: Message[]; notices: Map<string, MemoryEvent[]> } {
  const kept: Message[] = [];
  const merged = new Map<string, MemoryEvent[]>();
  let open: MemoryEvent[] | undefined;
  for (const row of rows) {
    const event = notices.get(row.id);
    if (event === undefined) { open = undefined; kept.push(row); continue; }
    if (open && sameNotice(open.at(-1), event)) { open.push(event); continue; }
    open = [event];
    merged.set(row.id, open);
    kept.push(row);
  }
  return { rows: kept, notices: merged };
}

/**
 * Break folded activity runs at notice boundaries so later calls cannot cover them.
 * `from` and `to` name the parts one row of a cut message draws (`timeline-rows.ts`):
 * its runs keep the indices they have in the whole message, and a notice shows in
 * the row that holds its part, the last row for one anchored at the message's end.
 */
export function memoryPartRuns(parts: MessagePart[], events: MemoryEvent[], from = 0, to = parts.length, groupChanges = false): (PartRun | MemoryRun)[] {
  if (!events.length) return partRuns(parts, from, to, groupChanges);
  const boundaries = new Map<number, MemoryEvent[]>();
  for (const event of events) {
    const index = Math.max(0, Math.min(event.anchor?.partIndex ?? parts.length, parts.length));
    if (index < from || (index >= to && to < parts.length)) continue;
    boundaries.set(index, [...(boundaries.get(index) ?? []), event]);
  }
  if (boundaries.size === 0) return partRuns(parts, from, to, groupChanges);
  const runs: (PartRun | MemoryRun)[] = [];
  let start = from;
  for (const [end, notices] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    runs.push(...partRuns(parts, start, end, groupChanges));
    for (const [index, event] of notices.entries()) {
      const previous = runs.at(-1);
      if (previous?.kind === 'memory' && sameNotice(previous.events.at(-1), event)) previous.events.push(event);
      else runs.push({ kind: 'memory', key: `memory-${end}-${index}`, events: [event] });
    }
    start = end;
  }
  runs.push(...partRuns(parts, start, to, groupChanges));
  return runs;
}

type MessageRun = PartRun | MemoryRun;

function sameRun(before: MessageRun, run: MessageRun): boolean {
  if (run.kind === 'part') return before.kind === 'part' && before.index === run.index;
  if (run.kind === 'activity') return before.kind === 'activity' && before.indices.length === run.indices.length && before.indices.every((at, index) => at === run.indices[index]);
  return before.kind === 'memory' && before.events.length === run.events.length && before.events.every((event, index) => event === run.events[index]);
}

/**
 * memoryPartRuns for one row that keeps what it built, as `TimelineRows` does:
 * a run over the same parts comes back as the same object, and the same array
 * while every run is the same. A part arriving at the end then hands no new
 * `parts` to the groups above it.
 */
export class MessageRuns {
  #runs: MessageRun[] = [];

  build(parts: MessagePart[], events: MemoryEvent[], from = 0, to = parts.length, groupChanges = false): MessageRun[] {
    const known = new Map(this.#runs.map(run => [run.kind === 'memory' ? run.key : runKey(run), run]));
    let same = true;
    const runs = memoryPartRuns(parts, events, from, to, groupChanges).map((run, index) => {
      const before = known.get(run.kind === 'memory' ? run.key : runKey(run));
      const kept = before && sameRun(before, run) ? before : run;
      if (kept !== this.#runs[index]) same = false;
      return kept;
    });
    if (same && runs.length === this.#runs.length) return this.#runs;
    this.#runs = runs;
    return runs;
  }
}
