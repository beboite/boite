/**
 * How two threads relate, and what a recipient reads about a letter's sender
 * beside the letter: that relation, the sender's task and the recipient's own
 * message it answers. Read from the journal each time: a delegation or a
 * steward grant can begin after a letter was written.
 */
import type { AgentAddress, AgentLetter, AgentRelation } from '@boite/contracts';
import { excerpt, type LetterContext } from './coordination-letter.ts';
import type { Core } from './core.ts';

/** How `other` relates to `threadId`: who started whom, delegation, the steward, else where it is. */
export function relationOf(core: Core, localCore: string, threadId: string, other: AgentAddress): AgentRelation {
  if (other.coreId !== 'local' && other.coreId !== localCore) return 'machine';
  const self = core.journal.getThread(threadId);
  const peer = core.journal.getThread(other.threadId);
  if (!self || !peer) return 'other-project';
  if (core.threads.spawns.originOf(self.id)?.threadId === peer.id) return 'starter';
  if (core.threads.spawns.originOf(peer.id)?.threadId === self.id) return 'started';
  if (self.parentThreadId === peer.id) return 'parent';
  if (peer.parentThreadId === self.id) return 'child';
  if (core.stewards.over(peer.id, self.id) !== null) return 'steward';
  if (core.stewards.over(self.id, peer.id) !== null) return 'stewarded';
  return self.projectId === peer.projectId ? 'project' : 'other-project';
}

/** Each letter with the relation of its other end to `threadId`, worked out once per correspondent. */
export function withRelations(core: Core, localCore: string, threadId: string, letters: AgentLetter[]): AgentLetter[] {
  const known = new Map<string, AgentRelation>();
  return letters.map(letter => {
    const other = letter.from.coreId === localCore && letter.from.threadId === threadId ? letter.to : letter.from;
    const key = `${other.coreId}/${other.threadId}`;
    const relation = known.get(key) ?? relationOf(core, localCore, threadId, other);
    known.set(key, relation);
    return { ...letter, relation };
  });
}

/**
 * What `threadId` reads about each sender: its relation, its task and the
 * recipient's own message it answers. The task is a local sender's declared
 * resources or the request it opened with; another machine shares its
 * resources only, never its chat.
 */
export function senderContext(core: Core, localCore: string, threadId: string): (letter: AgentLetter) => LetterContext {
  return letter => {
    const relation = relationOf(core, localCore, threadId, letter.from);
    const local = relation !== 'machine';
    const about = letter.from.resources.trim() ? excerpt(letter.from.resources) : local ? openingRequest(core, letter.from.threadId) : undefined;
    const answered = letter.replyTo
      ? core.journal.db.query("SELECT data FROM coordination_letters WHERE id = ? AND thread_id = ? AND direction = 'out'").get(letter.replyTo, threadId) as { data: string } | null
      : null;
    const yours = answered ? excerpt((JSON.parse(answered.data) as AgentLetter).text) : undefined;
    return { relation, ...(about ? { about } : {}), ...(yours ? { yours } : {}) };
  };
}

/** The first thing asked in a local thread, as its user or starter wrote it. */
function openingRequest(core: Core, threadId: string): string | undefined {
  const row = core.journal.db.query("SELECT parts FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at LIMIT 1").get(threadId) as { parts: string } | null;
  if (!row) return undefined;
  const parts = JSON.parse(row.parts) as { type: string; text?: string; displayText?: string }[];
  const text = parts.map(part => part.type === 'text' ? part.displayText ?? part.text ?? '' : '').join(' ').trim();
  return text ? excerpt(text) : undefined;
}
