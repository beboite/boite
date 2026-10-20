import type { AgentAddress, AgentLetter, AgentProfile, AgentRelation, Message, ThreadStatus, Turn } from '@boite/contracts';
import type { Store } from './store.svelte';

export type MailDirection = 'incoming' | 'outgoing';
export interface AgentMail {
  letter: AgentLetter;
  self: AgentAddress;
  direction: MailDirection;
  projectName?: string;
  /** The discussion this letter belongs to: one per conversation on the other end (`discussionKey`). */
  peer: string;
  /** How the other end relates to this thread, when the core or the delegation tree says. */
  relation?: AgentRelation;
}
export interface AgentMailGroup {
  id: string;
  entries: AgentMail[];
}

/**
 * One key per conversation on the other end. Coordination names this machine
 * by its core id and delegation by `local`: both are `here`, so a subagent's
 * results and its coordination letters land in one discussion.
 */
export function discussionKey(address: AgentAddress, localCores: readonly string[]): string {
  return `${address.coreId === 'local' || localCores.includes(address.coreId) ? 'here' : address.coreId}/${address.threadId}`;
}

/** Coordination and delegation have distinct local identities, even on the same machine. */
export function agentMailFor(store: Pick<Store, 'coordination' | 'delegation' | 'threads' | 'projects'>, threadId: string): AgentMail[] {
  const coordination = store.coordination?.self.threadId === threadId ? store.coordination : null;
  const delegation = store.delegation && (store.delegation.rootThreadId === threadId || store.delegation.agents.some(agent => agent.thread.id === threadId)) ? store.delegation : null;
  const localCores = coordination ? [coordination.self.coreId] : [];
  const entries = new Map<string, AgentMail>();
  function add(letter: AgentLetter, self: AgentAddress, relation?: AgentRelation): void {
    const direction = letter.from.coreId === self.coreId && letter.from.threadId === threadId ? 'outgoing' : 'incoming';
    const address = direction === 'outgoing' ? letter.to : letter.from;
    const thread = address.coreId === self.coreId
      ? store.threads?.find(thread => thread.id === address.threadId) ?? delegation?.agents.find(agent => agent.thread.id === address.threadId)?.thread
      : undefined;
    const projectName = store.projects?.find(project => project.id === thread?.projectId)?.name;
    const known = relation ?? letter.relation ?? entries.get(letter.id)?.relation;
    entries.set(letter.id, { letter, self, direction, projectName, peer: discussionKey(address, localCores), ...(known ? { relation: known } : {}) });
  }
  for (const letter of coordination?.messages ?? []) add(letter, coordination!.self);
  for (const letter of delegation?.messages ?? []) {
    if (letter.from.threadId !== threadId && letter.to.threadId !== threadId) continue;
    const other = letter.from.threadId === threadId ? letter.to.threadId : letter.from.threadId;
    // The delegation tree is one level deep: the root's correspondents are its subagents, a subagent's is its root.
    add(letter, { coreId: 'local', threadId }, delegation!.rootThreadId === threadId ? (delegation!.agents.some(agent => agent.thread.id === other) ? 'child' : undefined) : other === delegation!.rootThreadId ? 'parent' : undefined);
  }
  return [...entries.values()].sort((a, b) => a.letter.createdAt - b.letter.createdAt || a.letter.id.localeCompare(b.letter.id));
}

/** Everything one thread said to one other conversation, and what is known about that conversation. */
export interface Discussion {
  key: string;
  /** The other conversation, for opening it. */
  address: AgentAddress;
  /** This thread's own address on the letters, what `workspace.openAgentThread` takes. */
  self: AgentAddress;
  title: string;
  project?: string;
  /** Only for a conversation on another machine. */
  machine?: string;
  providerId?: string;
  model?: string;
  branch?: string | null;
  /** What the other agent declared it works on. */
  about?: string;
  /** Known only for a conversation on this machine. */
  status?: ThreadStatus;
  relation?: AgentRelation;
  /** The other end is the persistent agent the owner entrusted this thread's project to. */
  resident: boolean;
  /** That agent, when the agents directory knows the thread it writes from. */
  agent?: Pick<AgentProfile, 'id' | 'name' | 'avatar'>;
  /** The other end is on a contact's Boite: the name this owner gave that contact, from the letters this core labelled. */
  contact?: string;
  entries: AgentMail[];
  sent: number;
  received: number;
  last: AgentMail;
}

/** `claude claude-opus-5-5` as a contact names its agent: provider, then model. */
function agentOf(value: string | undefined): { providerId?: string; model?: string } {
  const [providerId, ...model] = (value ?? '').trim().split(/\s+/);
  return providerId ? { providerId, ...(model.length ? { model: model.join(' ') } : {}) } : {};
}

/**
 * The thread's mail as discussions, the most recent first. A local thread's
 * live summary wins over what a letter recorded when it was written: titles
 * change and agents finish. `agents` names the persistent agent behind a
 * thread of this machine (the agents directory, with the Agents experiment
 * on): a resident discussion takes that agent's name. `history` is the
 * thread's whole mail when `mail` is a part of it: a part holding only this
 * thread's letters learns the other agent from what it wrote earlier.
 */
export function discussionsOf(mail: AgentMail[], store: Pick<Store, 'threads' | 'projects'> & Partial<Pick<Store, 'delegation'>>,
  agents?: { agentOfThread(threadId: string): AgentProfile | null }, history?: AgentMail[]): Discussion[] {
  const byPeer = new Map<string, AgentMail[]>();
  for (const entry of mail) byPeer.set(entry.peer, [...(byPeer.get(entry.peer) ?? []), entry]);
  const discussions = [...byPeer].map(([key, entries]): Discussion => {
    const last = entries.at(-1)!;
    const heard = (entries.findLast(entry => entry.direction === 'incoming') ?? history?.findLast(entry => entry.peer === key && entry.direction === 'incoming'))?.letter.from;
    const told = entries.findLast(entry => entry.direction === 'outgoing')?.letter;
    const address = last.direction === 'outgoing' ? last.letter.to : last.letter.from;
    const here = key.startsWith('here/');
    const live = here ? store.threads?.find(thread => thread.id === address.threadId) ?? store.delegation?.agents.find(agent => agent.thread.id === address.threadId)?.thread : undefined;
    const fromLetters = agentOf(heard?.agent);
    const relation = entries.findLast(entry => entry.relation)?.relation;
    const resident = relation === 'resident' || entries.some(entry => entry.direction === 'incoming' && entry.letter.origin === 'resident');
    const found = resident && here ? agents?.agentOfThread(address.threadId) : null;
    const agent = found ? { id: found.id, name: found.name, avatar: found.avatar } : undefined;
    // The receiving core labels a contact's letters; the newest label wins, so a rename shows at once.
    const contact = (entries.findLast(entry => entry.letter.contact) ?? history?.findLast(entry => entry.peer === key && entry.letter.contact))?.letter.contact?.name;
    return {
      key, address, self: last.self,
      title: agent?.name || live?.title || heard?.title || told?.toTitle || address.threadId,
      project: (live && store.projects?.find(project => project.id === live.projectId)?.name) || heard?.project || told?.toProject || last.projectName,
      ...(here ? {} : { machine: heard?.machine || told?.toMachine }),
      ...(live ? { providerId: live.providerId, model: live.model ?? undefined } : fromLetters),
      branch: live ? live.branch : heard?.branch,
      about: heard?.resources?.trim() || undefined,
      // A letter's status is the sender's when it wrote, nearly always running: only a live summary says what it does now.
      status: live?.status,
      relation, resident, ...(agent ? { agent } : {}), ...(contact ? { contact } : {}),
      entries, last,
      sent: entries.filter(entry => entry.direction === 'outgoing').length,
      received: entries.filter(entry => entry.direction === 'incoming').length,
    };
  });
  return discussions.sort((a, b) => b.last.letter.createdAt - a.last.letter.createdAt || a.key.localeCompare(b.key));
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

/** The relations worth a tag: who started or delegated whom, and the agent that looks after the project. */
export type Hierarchy = Exclude<AgentRelation, 'project' | 'other-project' | 'machine'>;
/** The tag of a discussion; where a thread runs is said by its project and machine instead. */
export function hierarchyOf(discussion: Pick<Discussion, 'relation' | 'resident'>): Hierarchy | undefined {
  if (discussion.resident) return 'resident';
  const relation = discussion.relation;
  return relation === 'project' || relation === 'other-project' || relation === 'machine' ? undefined : relation;
}

/** Project and machine of the other end, the line under its title. */
export function whereOf(discussion: Pick<Discussion, 'project' | 'machine'>): string {
  return [discussion.project, discussion.machine].filter(Boolean).join(' · ');
}
