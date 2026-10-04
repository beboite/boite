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

/** Break folded activity runs at notice boundaries so later calls cannot cover them. */
export function memoryPartRuns(parts: MessagePart[], events: MemoryEvent[]): (PartRun | MemoryRun)[] {
  if (!events.length) return partRuns(parts);
  const boundaries = new Map<number, MemoryEvent[]>();
  for (const event of events) {
    const index = Math.max(0, Math.min(event.anchor?.partIndex ?? parts.length, parts.length));
    boundaries.set(index, [...(boundaries.get(index) ?? []), event]);
  }
  const runs: (PartRun | MemoryRun)[] = [];
  let start = 0;
  for (const [end, notices] of [...boundaries].sort((a, b) => a[0] - b[0])) {
    runs.push(...shiftedRuns(parts, start, end));
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
  runs.push(...shiftedRuns(parts, start, parts.length));
  return runs;
}

function shiftedRuns(parts: MessagePart[], start: number, end: number): PartRun[] {
  return partRuns(parts.slice(start, end)).map(run => run.kind === 'part'
    ? { kind: 'part', index: run.index + start }
    : { kind: 'activity', indices: run.indices.map(index => index + start) });
}
