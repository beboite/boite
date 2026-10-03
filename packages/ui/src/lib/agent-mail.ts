import type { AgentAddress, AgentLetter, Message, Turn } from '@boite/contracts';
import type { Store } from './store.svelte';

export type MailDirection = 'incoming' | 'outgoing';
export interface AgentMail {
  letter: AgentLetter;
  self: AgentAddress;
  direction: MailDirection;
  projectName?: string;
}
export interface AgentMailGroup {
  id: string;
  entries: AgentMail[];
}

/** Coordination and delegation have distinct local identities, even on the same machine. */
export function agentMailFor(store: Pick<Store, 'coordination' | 'delegation' | 'threads' | 'projects'>, threadId: string): AgentMail[] {
  const coordination = store.coordination?.self.threadId === threadId ? store.coordination : null;
  const delegation = store.delegation && (store.delegation.rootThreadId === threadId || store.delegation.agents.some(agent => agent.thread.id === threadId)) ? store.delegation : null;
  const entries = new Map<string, AgentMail>();
  function add(letter: AgentLetter, self: AgentAddress): void {
    const direction = letter.from.coreId === self.coreId && letter.from.threadId === threadId ? 'outgoing' : 'incoming';
    const address = direction === 'outgoing' ? letter.to : letter.from;
    const thread = address.coreId === self.coreId
      ? store.threads?.find(thread => thread.id === address.threadId) ?? delegation?.agents.find(agent => agent.thread.id === address.threadId)?.thread
      : undefined;
    const projectName = store.projects?.find(project => project.id === thread?.projectId)?.name;
    entries.set(letter.id, { letter, self, direction, projectName });
  }
  for (const letter of coordination?.messages ?? []) add(letter, coordination!.self);
  for (const letter of delegation?.messages ?? []) {
    if (letter.from.threadId === threadId || letter.to.threadId === threadId) add(letter, { coreId: 'local', threadId });
  }
  return [...entries.values()].sort((a, b) => a.letter.createdAt - b.letter.createdAt || a.letter.id.localeCompare(b.letter.id));
}

/** Replace provider envelopes with their letters, retaining the turn that received them. */
export function withAgentMail(messages: Message[], mail: AgentMail[], threadId: string, turns: Turn[] = []): Message[] {
  const ids = mail.map(entry => entry.letter.id);
  const deliveredIn = new Map<string, string>();
  const visible = messages.filter(message => {
    if (message.role !== 'system') return true;
    const envelopes = message.parts.flatMap(part => part.type === 'text' &&
      (part.text.startsWith('Boite agent coordination.') || part.text.startsWith('Boite delegation messages.')) ? [part.text] : []);
    const matched = ids.filter(id => envelopes.some(text => text.includes(`"id":"${id}"`)));
    for (const id of matched) deliveredIn.set(id, message.turnId);
    return matched.length === 0;
  });
  const turnOf = (letter: AgentLetter): string => deliveredIn.get(letter.id) ?? turns.findLast(turn =>
    turn.startedAt !== null && turn.startedAt <= letter.createdAt && (turn.finishedAt === null || letter.createdAt <= turn.finishedAt))?.id ?? `coordination:${letter.id}`;
  return [...visible, ...mail.map(({ letter }): Message => ({
    id: `coordination:${letter.id}`, threadId, turnId: turnOf(letter),
    role: 'system', parts: [], state: 'complete', createdAt: letter.createdAt
  }))];
}

/** A burst has one stable row per turn; ordinary messages and activity markers keep their positions. */
export function groupAgentMail(timeline: Message[], mail: AgentMail[]): { timeline: Message[]; groups: Map<string, AgentMailGroup> } {
  const letters = new Map(mail.map(entry => [`coordination:${entry.letter.id}`, entry]));
  const groups = new Map<string, AgentMailGroup>();
  const rows: Message[] = [];
  let group: AgentMailGroup | undefined;
  let turnId: string | undefined;
  for (const message of timeline) {
    const entry = letters.get(message.id);
    const owner = message.turnId.startsWith('coordination:') ? undefined : message.turnId;
    if (!entry) {
      group = undefined;
      rows.push(message);
    } else if (group && turnId === owner) group.entries.push(entry);
    else {
      group = { id: message.id, entries: [entry] };
      turnId = owner;
      groups.set(group.id, group);
      rows.push(message);
    }
  }
  return { timeline: rows, groups };
}

export function mailNeedsAttention(entry: AgentMail): boolean {
  return ['uncertain', 'expired', 'rejected'].includes(entry.letter.status);
}
