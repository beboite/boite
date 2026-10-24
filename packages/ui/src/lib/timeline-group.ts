import type { MemoryEvent, Message, Turn } from '@boite/contracts';
import { groupAgentMail, withAgentMail, type AgentMail, type AgentMailGroup } from './agent-mail';
import { mergeNoticeRows } from './memory-timeline';

/** Rows that follow the message sharing their millisecond: agent mail and a launch card, anchored with `<=`. */
const after = (row: Message) => row.id.startsWith('coordination:') || row.id.startsWith('delegation:');
/** A row of its own at its time: a launch card, a workflow run, a memory notice. */
const marker = (threadId: string, id: string, createdAt: number): Message => ({ id, threadId, turnId: id, role: 'system', parts: [], state: 'complete', createdAt });

/**
 * The thread's messages with what else happened among them placed by time:
 * agent mail (grouped), launch cards, workflow runs and memory notices
 * (merged). The messages come back as they are when there is none.
 */
export function groupTimeline(messages: Message[], threadId: string, turns: Turn[], mail: AgentMail[], launches: ReadonlyMap<string, { createdAt: number }>,
  runs: ReadonlyMap<string, { createdAt: number }>, memoryRows: ReadonlyMap<string, MemoryEvent>): { timeline: Message[]; groups: Map<string, AgentMailGroup>; notices: Map<string, MemoryEvent[]> } {
  if (mail.length === 0 && launches.size === 0 && runs.size === 0 && memoryRows.size === 0) return { timeline: messages, groups: new Map(), notices: new Map() };
  const rows = [
    ...[...launches].map(([id, launch]) => marker(threadId, id, launch.createdAt)),
    ...[...runs].map(([id, run]) => marker(threadId, id, run.createdAt)),
    ...[...memoryRows].map(([id, event]) => marker(threadId, id, event.at)),
  ];
  // Output that already existed in this millisecond precedes its exchange.
  const sorted = [...withAgentMail(messages, mail, threadId, turns), ...rows].sort((a, b) =>
    a.createdAt - b.createdAt || Number(after(a)) - Number(after(b)) || a.id.localeCompare(b.id));
  const merged = mergeNoticeRows(sorted, memoryRows);
  return { ...groupAgentMail(merged.rows, mail), notices: merged.notices };
}
