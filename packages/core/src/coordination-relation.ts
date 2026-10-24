/**
 * How two threads relate, and what a recipient reads about a letter's sender
 * beside the letter: that relation, the sender's task and the recipient's own
 * message it answers. Read from the journal each time: a delegation or an
 * entrusted project can begin after a letter was written.
 */
import type { AgentAddress, AgentLetter, AgentRelation } from '@boite/contracts';
import { excerpt, type LetterContext } from './coordination-letter.ts';
import type { Core } from './core.ts';

export function projectName(core: Core, threadId: string): string | undefined {
  const projectId = core.journal.getThread(threadId)?.projectId;
  return projectId ? core.journal.getProject(projectId)?.name.slice(0, 200) : undefined;
}

/** Old local letters predate project metadata. Fill it without rewriting history. */
export function withProjects(core: Core, local: string, letter: AgentLetter): AgentLetter {
  return { ...letter,
    from: letter.from.coreId === local && letter.from.project === undefined ? { ...letter.from, project: projectName(core, letter.from.threadId) } : letter.from,
    toProject: letter.toProject ?? (letter.to.coreId === local ? projectName(core, letter.to.threadId) : undefined),
  };
}

/** How `other` relates to `threadId`: who started whom, delegation, the agent the project is entrusted to, else where it is. */
export function relationOf(core: Core, localCore: string, threadId: string, other: AgentAddress): AgentRelation {
  if (other.coreId !== 'local' && other.coreId !== localCore) {
    // `boite thread new --machine`: the two ends still know who started whom.
    if (core.threads.spawns.originCore(threadId) === other.coreId && core.threads.spawns.originOf(threadId)?.threadId === other.threadId) return 'starter';
    if (core.threads.spawns.startedOn(threadId, other.coreId, other.threadId)) return 'started';
    return 'machine';
  }
  const self = core.journal.getThread(threadId);
  const peer = core.journal.getThread(other.threadId);
  if (!self || !peer) return 'other-project';
  if (core.threads.spawns.originOf(self.id)?.threadId === peer.id) return 'starter';
  if (core.threads.spawns.originOf(peer.id)?.threadId === self.id) return 'started';
  if (self.parentThreadId === peer.id) return 'parent';
  if (peer.parentThreadId === self.id) return 'child';
  if (core.workforce.projects.over(peer.id, self.id) !== null) return 'resident';
  return self.projectId === peer.projectId ? 'project' : 'other-project';
}

/** Each letter with the relation of its other end to `threadId`, worked out once per correspondent. */
export function withRelations(core: Core, localCore: string, threadId: string, letters: AgentLetter[]): AgentLetter[] {
  const known = new Map<string, AgentRelation | undefined>();
  return letters.map(letter => {
    const other = letter.from.coreId === localCore && letter.from.threadId === threadId ? letter.to : letter.from;
    const key = `${other.coreId}/${other.threadId}`;
    const relation = known.has(key) ? known.get(key) : enriched(core, threadId, () => relationOf(core, localCore, threadId, other), undefined);
    known.set(key, relation);
    return relation === undefined ? letter : { ...letter, relation };
  });
}

/**
 * Enrichment reads journal rows a corrupt or older entry can break. It must not
 * stop delivery: claimed letters are already marked delivered, and a throw in
 * `deliver` would pause the thread. The failure goes to the diagnostic log.
 */
function enriched<T>(core: Core, threadId: string, read: () => T, fallback: T): T {
  try { return read(); } catch (error) {
    try { core.logs.warn(`letter context unreadable: ${error instanceof Error ? error.message : String(error)}`, { source: 'coordination', event: 'coordination.context-failed', threadId }); } catch { /* A failed log write is dropped too. */ }
    return fallback;
  }
}

/**
 * What `threadId` reads about each sender: its relation, its task and the
 * recipient's own message it answers. The task is a local sender's declared
 * resources or the request it opened with; another machine shares its
 * resources only, never its chat.
 */
export function senderContext(core: Core, localCore: string, threadId: string): (letter: AgentLetter) => LetterContext {
  return letter => enriched<LetterContext>(core, threadId, () => {
    const relation = relationOf(core, localCore, threadId, letter.from);
    const local = relation !== 'machine';
    // A row older than its field, or a peer that left it out, must not stop delivery.
    const resources = typeof letter.from.resources === 'string' ? letter.from.resources.trim() : '';
    // An ordinary letter reached this thread because its sender is a contact it may already read with
    // `boite threads read`; the conversation of the agent a project is entrusted to spans the user's other work, so it says nothing more.
    const about = resources ? excerpt(resources) : local && letter.origin !== 'resident' ? openingRequest(core, letter.from.threadId) : undefined;
    const answered = letter.replyTo
      ? core.journal.db.query("SELECT data FROM coordination_letters WHERE id = ? AND thread_id = ? AND direction = 'out'").get(letter.replyTo, threadId) as { data: string } | null
      : null;
    const yours = answered ? excerpt((JSON.parse(answered.data) as AgentLetter).text) : undefined;
    return { relation, ...(about ? { about } : {}), ...(yours ? { yours } : {}) };
  }, {});
}

/** The first thing asked in a local thread, as its user or starter wrote it. */
function openingRequest(core: Core, threadId: string): string | undefined {
  const row = core.journal.db.query("SELECT parts FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY created_at LIMIT 1").get(threadId) as { parts: string } | null;
  if (!row) return undefined;
  const parts = JSON.parse(row.parts) as { type: string; text?: string; displayText?: string }[];
  const text = parts.map(part => part.type === 'text' ? part.displayText ?? part.text ?? '' : '').join(' ').trim();
  return text ? excerpt(text) : undefined;
}
