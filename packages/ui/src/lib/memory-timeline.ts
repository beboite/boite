import type { MemoryEvent, Message, MessagePart } from '@boite/contracts';
import { partRuns, type PartRun } from './tool-groups';

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

/**
 * Break folded activity runs at notice boundaries so later calls cannot cover them.
 * `from` and `to` name the parts one row of a cut message draws (`timeline-rows.ts`):
 * its runs keep the indices they have in the whole message, and a notice shows in
 * the row that holds its part, the last row for one anchored at the message's end.
 */
export function memoryPartRuns(parts: MessagePart[], events: MemoryEvent[], from = 0, to = parts.length): (PartRun | MemoryRun)[] {
  if (!events.length) return partRuns(parts, from, to);
  const boundaries = new Map<number, MemoryEvent[]>();
  for (const event of events) {
    const index = Math.max(0, Math.min(event.anchor?.partIndex ?? parts.length, parts.length));
    if (index < from || (index >= to && to < parts.length)) continue;
    boundaries.set(index, [...(boundaries.get(index) ?? []), event]);
  }
  if (boundaries.size === 0) return partRuns(parts, from, to);
  const runs: (PartRun | MemoryRun)[] = [];
  let start = from;
  for (const [end, notices] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    runs.push(...partRuns(parts, start, end));
    // Group consecutive stops only when their reason and threshold match.
    for (const [index, event] of notices.entries()) {
      const previous = runs.at(-1);
      const last = previous?.kind === 'memory' ? previous.events.at(-1) : undefined;
      if (previous?.kind === 'memory' && last?.kind === 'killed' && event.kind === 'killed' &&
        last.reason === event.reason && last.limitBytes === event.limitBytes && event.at - last.at <= 10000) previous.events.push(event);
      else runs.push({ kind: 'memory', key: `memory-${end}-${index}`, events: [event] });
    }
    start = end;
  }
  runs.push(...partRuns(parts, start, to));
  return runs;
}

