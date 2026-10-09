/*
 * The agents that stand as the companion, as the agents snapshot shows them
 * (`crew.svelte.ts` follows it): each agent's direct conversation, the reply
 * and the work a request got, its memory and what the companion saves back
 * to it. Pure, so it is tested without a core.
 */
import type { AgentConversationMessage, AgentMemory, AgentProfile, AgentSave, AgentScope, AgentsSnapshot, AgentWork } from '@boite/contracts';
import { BOX_COLORS, encodeRobot, ROBOT_PARTS, robotOf, seededRobot, type Robot } from '../robots';
import type { Brain } from './brain';
import { namesFact, normalized } from './memory';
import { toBox, type BoxRobot } from './skin';

/** The name of the agent the companion makes for itself the first time. */
export const FIRST_AGENT_NAME = 'Bots';
/** The classic companion, as an avatar: the first agent keeps the look the companion always had. */
export const CLASSIC_SKIN = encodeRobot({ family: 'box', shape: 0, color: 0, eyes: 0, top: 0 });

/** The box an agent stands as: its own robot made a box, keeping its colour, or the box its id draws. */
export function skinOf(profile: Pick<AgentProfile, 'id' | 'avatar'>): BoxRobot {
  return toBox(robotOf(profile.id, profile.avatar) ?? seededRobot(profile.id, 'box'));
}

/**
 * A look to tell an agent apart from `others`, as an avatar: the box `seed`
 * draws, on a body colour none of them wears while one is left (never the
 * classic body, which the first agent keeps), with an accessory on its lid.
 */
export function freshSkin(seed: string, others: Robot[]): string {
  const drawn = seededRobot(seed, 'box');
  const worn = new Set(others.map((robot) => robot.color));
  const colors = Array.from({ length: BOX_COLORS - 1 }, (_, index) => index + 1);
  const free = colors.filter((color) => !worn.has(color));
  const pool = free.length > 0 ? free : colors;
  const top = drawn.top === 0 ? 1 + (drawn.eyes % (ROBOT_PARTS.box.top - 1)) : drawn.top;
  return encodeRobot({ ...drawn, color: pool[drawn.color % pool.length]!, top });
}

/** The collaboration tools a companion agent gets, as the Agents page gives a new agent. */
export const AGENT_TOOLS = ['messages', 'missions', 'memory', 'artifacts', 'decisions', 'routines'];
/** The longest title a memory takes (`agents.memory.save`). */
const TITLE_MAX = 200;
const TEXT_MAX = 32_000;

/** The conversation between the user and one agent alone. */
export const directScope = (agentId: string): AgentScope => ({ kind: 'agent', id: agentId });
const isDirect = (scope: AgentScope, agentId: string): boolean => scope.kind === 'agent' && scope.id === agentId;
const byCreation = (a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt;

/** The row's agents in the order the user put them; one archived or gone is left out. */
export function membersOf(snapshot: AgentsSnapshot | null, ids: string[]): AgentProfile[] {
  if (!snapshot) return [];
  return ids.flatMap((id) => snapshot.profiles.filter((profile) => profile.id === id && profile.status !== 'archived'));
}

/** The thread the agent works its direct conversation in, once it has worked there. */
export function sessionThreadOf(snapshot: AgentsSnapshot | null, agentId: string): string | null {
  return snapshot?.sessions.find((session) => session.agentId === agentId && isDirect(session.scope, agentId))?.threadId ?? null;
}

/** The direct conversation with the agent, oldest first, as far back as the snapshot goes. */
export function conversationOf(snapshot: AgentsSnapshot | null, agentId: string): AgentConversationMessage[] {
  return (snapshot?.messages ?? []).filter((message) => isDirect(message.scope, agentId)).sort(byCreation);
}

/** The agent's answer to a message, once written. */
export function replyTo(snapshot: AgentsSnapshot | null, agentId: string, messageId: string): AgentConversationMessage | null {
  return snapshot?.messages.find((message) => message.replyTo === messageId && message.senderId === agentId) ?? null;
}

/** The work a message gave the agent, once the core made it. */
export function workFor(snapshot: AgentsSnapshot | null, agentId: string, messageId: string): AgentWork | null {
  return snapshot?.work.find((work) => work.messageId === messageId && work.agentId === agentId && work.purpose !== 'compaction') ?? null;
}

/** Work that ended without an answer. */
export const workFailed = (work: AgentWork): boolean => work.status === 'error' || work.status === 'cancelled' || work.status === 'interrupted';

/** The agent's own messages in its direct conversation written after `mark`, oldest first; a note about an entrusted thread is not one. */
export function repliesAfter(snapshot: AgentsSnapshot | null, agentId: string, mark: number): AgentConversationMessage[] {
  return conversationOf(snapshot, agentId).filter((message) => message.senderId === agentId && message.createdAt > mark && !message.thread);
}

/** When the newest message of the conversation was written: where a first look starts, so older answers are not carried out again. */
export function lastMessageAt(snapshot: AgentsSnapshot | null, agentId: string): number {
  return conversationOf(snapshot, agentId).reduce((last, message) => Math.max(last, message.createdAt), 0);
}

/** The memories the agent is given: its own, not expired. */
export function liveMemories(snapshot: AgentsSnapshot | null, agentId: string, now = Date.now()): AgentMemory[] {
  return (snapshot?.memories ?? []).filter((memory) => isDirect(memory.scope, agentId) && (memory.expiresAt === null || memory.expiresAt > now)).sort(byCreation);
}

/** A fact for the agent's memory (`[[remember: …]]`); null when it is empty or the agent already has it. */
export function memoryToKeep(memories: AgentMemory[], agentId: string, fact: string): AgentSave<AgentMemory> | null {
  const clean = fact.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const key = normalized(clean);
  if (memories.some((memory) => normalized(memory.text) === key)) return null;
  const scope = directScope(agentId);
  return { value: { scope, title: clean.slice(0, TITLE_MAX), text: clean.slice(0, TEXT_MAX), sourceScopes: [scope], sourceRunId: null, expiresAt: null } };
}

/** The memories a `[[forget: …]]` names (`namesFact`), expired now, the way the Agents page deletes one. */
export function memoriesToForget(memories: AgentMemory[], query: string, now = Date.now()): AgentSave<AgentMemory>[] {
  return memories
    .filter((memory) => namesFact(query, memory.text))
    .map(({ id, revision, scope, title, text, sourceScopes, sourceRunId }) => ({ id, expectedRevision: revision, value: { scope, title, text, sourceScopes, sourceRunId, expiresAt: now } }));
}

/** A new agent that stands as the companion, the role already in its instructions. */
export function companionAgent(name: string, domain: string, instructions: string, avatar: string, brain: Brain, permissionMode: AgentProfile['selection']['permissionMode']): AgentSave<AgentProfile> {
  return {
    value: {
      name,
      domain,
      instructions,
      avatar,
      selection: { ...brain, permissionMode },
      status: 'active',
      tools: [...AGENT_TOOLS],
      accountIntegration: 'provider'
    }
  };
}

/** The profile saved again with other instructions or another face, at the revision it was read. */
export function profileWith(profile: AgentProfile, change: Partial<Pick<AgentProfile, 'instructions' | 'avatar'>>): AgentSave<AgentProfile> {
  const { name, domain, instructions, avatar, selection, status, tools, accountIntegration } = profile;
  return { id: profile.id, expectedRevision: profile.revision, value: { name, domain, instructions, avatar, selection, status, tools, accountIntegration, ...change } };
}
