import type { AgentAddress, AgentLetter, Message } from '@boite/contracts';
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

/** Hide provider envelopes only when their letters are available to read. */
export function withAgentMail(messages: Message[], mail: AgentMail[], threadId: string): Message[] {
  const ids = mail.map(entry => entry.letter.id);
  const visible = messages.filter(message => message.role !== 'system' || !message.parts.some(part => part.type === 'text' &&
    (part.text.startsWith('Boite agent coordination.') || part.text.startsWith('Boite delegation messages.')) &&
    ids.some(id => part.text.includes(`"id":"${id}"`))));
  return [...visible, ...mail.map(({ letter }): Message => ({
    id: `coordination:${letter.id}`, threadId, turnId: `coordination:${letter.id}`,
    role: 'system', parts: [], state: 'complete', createdAt: letter.createdAt
  }))];
}

/** A burst has one stable row; ordinary messages and activity markers keep their positions. */
export function groupAgentMail(timeline: Message[], mail: AgentMail[]): { timeline: Message[]; groups: Map<string, AgentMailGroup> } {
  const letters = new Map(mail.map(entry => [`coordination:${entry.letter.id}`, entry]));
  const groups = new Map<string, AgentMailGroup>();
  const rows: Message[] = [];
  let group: AgentMailGroup | undefined;
  for (const message of timeline) {
    const entry = letters.get(message.id);
    if (!entry) {
      group = undefined;
      rows.push(message);
    } else if (group) group.entries.push(entry);
    else {
      group = { id: message.id, entries: [entry] };
      groups.set(group.id, group);
      rows.push(message);
    }
  }
  return { timeline: rows, groups };
}

export function mailNeedsAttention(entry: AgentMail): boolean {
  return ['uncertain', 'expired', 'rejected'].includes(entry.letter.status);
}
