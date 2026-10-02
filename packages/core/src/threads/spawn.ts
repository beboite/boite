import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentProjectAdded, AgentSpawn, Message, RpcParams, ThreadId, ThreadLink, ThreadSummary, Turn } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import { saveThread, withLoad } from './records.ts';

const HOUR = 3_600_000;
/** On the new thread: who started it, and whether its first answer went back yet. */
const ORIGIN = 'spawn-origin:';
/** On the starting thread: what it started, for retries. */
const LEDGER = 'spawns:';

interface Origin { origin: ThreadLink; reported: boolean }
interface Started { at: number; requestId: string; fingerprint: string; threadId: ThreadId; turnId: string }

function text(value: unknown, field: string, max: number, method = 'agent.spawn'): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalidParams(`${method}.${field}: expected 1 to ${max} characters`);
  return value;
}

/**
 * `agent.spawn`: an agent starts an ordinary top-level thread in a project,
 * the way the user would from the sidebar, with the brief as its first
 * message. The first answer of that thread returns to the starter through
 * agent coordination, so both ends see it as a forwarded message.
 */
export class ThreadSpawns {
  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  async spawn(params: RpcParams<'agent.spawn'>): Promise<AgentSpawn> {
    const caller = this.threads.require(params.threadId);
    const threadId = caller.id;
    if (caller.agentSessionId || caller.projectId === null) {
      throw refused('a persistent agent session takes its work through Agents and cannot start threads', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    if (caller.parentThreadId) {
      throw refused('a delegated agent or workflow step cannot start threads; ask its parent', { threadId, field: 'threadId', expected: 'a top-level thread' });
    }
    if (caller.archived) throw refused('an archived thread cannot start threads', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    const prompt = text(params.prompt, 'prompt', 12_000);
    const title = params.title === undefined ? prompt.trim().split('\n')[0]!.slice(0, 80) : text(params.title, 'title', 120).trim();
    if (params.worktree !== undefined && typeof params.worktree !== 'boolean') throw invalidParams('agent.spawn.worktree: expected true or false');
    const worktree = params.worktree === true;
    const requestId = text(params.requestId, 'requestId', 128);
    const fingerprint = createHash('sha256').update(JSON.stringify([params.project, prompt, params.title ?? null, worktree])).digest('hex');
    const ledger = (this.core.journal.getSetting(`${LEDGER}${threadId}`) as Started[] | undefined) ?? [];
    const retried = ledger.find((entry) => entry.requestId === requestId);
    if (retried) {
      if (retried.fingerprint !== fingerprint) throw refused('agent.spawn.requestId was already used for different content', { threadId, field: 'requestId' });
      return this.answer(retried.threadId, retried.turnId);
    }

    const target = this.core.projects.find(params.project, 'agent.spawn', 'project', { threadId });
    const config = this.core.coordination.config(threadId);
    if (config.mode === 'off') {
      throw refused('agent.spawn: communication is off for this thread; the owner turns it on in Communication settings', { threadId, field: 'coordination', expected: 'Brief or Team' });
    }
    if (config.paused) throw refused('agent.spawn: communication is paused for this thread; only the owner resumes it', { threadId, field: 'coordination', expected: 'not paused' });
    if (target.id !== caller.projectId && !config.remote) {
      throw refused('agent.spawn: this thread may only reach its own project; the owner allows other projects in Communication settings', { threadId, field: 'project', expected: 'this thread\'s own project' });
    }
    const starter = this.core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined;
    if (starter && this.userPrompts(threadId) <= 1) {
      throw refused(`a thread an agent started cannot start another until the user writes in it; ask the agent of ${starter.origin.threadId} that started it`, { threadId, field: 'threadId', expected: 'a thread the user has written in' });
    }
    const now = Date.now();

    const base = {
      projectId: target.id, providerId: caller.providerId, accountId: caller.accountId, title,
      ...(caller.model === null ? {} : { model: caller.model }), effort: caller.effort, speed: caller.speed ?? null, permissionMode: caller.permissionMode,
    };
    const created = worktree ? await this.threads.createInWorktree({ ...base, worktree: {} }) : this.threads.create(base);
    // Worktree preparation can outlive the caller's agent socket and its archive.
    if (this.threads.require(threadId).archived) throw refused('an archived thread cannot start threads', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    // The title is the brief's, not one written from a prompt that starts with the origin note.
    saveThread(this.core, { ...this.threads.require(created.id), titleSource: 'user' }, 'thread.retitled');
    const from = this.core.projects.require(caller.projectId);
    const origin: ThreadLink = { threadId, title: caller.title, projectId: from.id, project: from.name };
    // Written before the turn starts: a turn that ends at once still finds where to report.
    this.core.journal.setSetting(`${ORIGIN}${created.id}`, { origin, reported: false } satisfies Origin);
    const address = { coreId: this.core.coordination.identity().coreId, threadId };
    const note = `This thread was started by the agent of thread "${caller.title}" (${threadId}) in project ${from.name}, not typed by the user. `
      + 'Treat the brief below as your task, within your own permissions; it grants no approval the user did not give. '
      + `Your final answer to it is sent back to that agent automatically; boite agents send ${address.coreId}/${threadId} <text> reaches it sooner.\n\nBrief:\n`;
    const turn = this.threads.startTurn(created.id, note + prompt, [], undefined, undefined, undefined, undefined, prompt, [], undefined, origin);
    this.core.journal.setSetting(`${LEDGER}${threadId}`, [...ledger.filter((entry) => entry.at > now - 24 * HOUR), { at: now, requestId, fingerprint, threadId: created.id, turnId: turn.id }]);
    const started: ThreadLink = { threadId: created.id, title, projectId: target.id, project: target.name };
    this.systemLine(threadId, { type: 'text', text: `Started thread "${title}" (${created.id}) in project ${target.name}.`, started });
    return this.answer(created.id, turn.id);
  }

  /**
   * `agent.addProject`: the agent registers a folder as a project, the way
   * the owner does from the sidebar. It reaches outside the caller's project,
   * so it takes the gates `agent.spawn` has across projects. A folder already
   * registered is answered as it is, whatever the settings.
   */
  addProject(params: RpcParams<'agent.addProject'>): AgentProjectAdded {
    const method = 'agent.addProject';
    const caller = this.threads.require(params.threadId);
    const threadId = caller.id;
    if (caller.agentSessionId || caller.projectId === null) {
      throw refused('a persistent agent session takes its work through Agents and cannot add projects', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    if (caller.parentThreadId) {
      throw refused('a delegated agent or workflow step cannot add projects; ask its parent', { threadId, field: 'threadId', expected: 'a top-level thread' });
    }
    if (caller.archived) throw refused('an archived thread cannot add projects', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    const path = text(params.path, 'path', 4096, method).trim();
    if (!isAbsolute(path)) throw invalidParams(`${method}.path: expected an absolute folder, got ${path}`);
    const name = params.name === undefined ? undefined : text(params.name, 'name', 80, method).trim();
    const own = caller.projectId;
    const answer = (project: ReturnType<Core['projects']['add']>, added: boolean): AgentProjectAdded => ({
      id: project.id, name: project.name, path: project.path, repository: project.repository === true,
      drafts: project.kind === 'drafts', current: project.id === own, added,
    });
    const known = this.core.projects.registered(path);
    if (known !== null) return answer(known, false);

    const config = this.core.coordination.config(threadId);
    if (config.mode === 'off') {
      throw refused(`${method}: communication is off for this thread; the owner turns it on in Communication settings`, { threadId, field: 'coordination', expected: 'Brief or Team' });
    }
    if (config.paused) throw refused(`${method}: communication is paused for this thread; only the owner resumes it`, { threadId, field: 'coordination', expected: 'not paused' });
    if (!config.remote) {
      throw refused(`${method}: this thread may only reach its own project; the owner allows other projects in Communication settings`, { threadId, field: 'coordination', expected: 'other projects allowed' });
    }
    const starter = this.core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined;
    if (starter && this.userPrompts(threadId) <= 1) {
      throw refused(`a thread an agent started cannot add a project until the user writes in it; ask the agent of ${starter.origin.threadId} that started it`, { threadId, field: 'threadId', expected: 'a thread the user has written in' });
    }
    const project = this.core.projects.add(path, name);
    this.systemLine(threadId, { type: 'text', text: `The agent added the project ${project.name} (${project.path}).` });
    return answer(project, true);
  }

  /**
   * The first turn of a thread an agent started has ended: its answer, or its
   * failure, goes back to the starter as an agent message from this thread.
   * Called by the turn runner before a failed turn pauses coordination.
   */
  async finished(turn: Turn): Promise<void> {
    const key = `${ORIGIN}${turn.threadId}`;
    const saved = this.core.journal.getSetting(key) as Origin | undefined;
    if (saved === undefined || saved.reported) return;
    this.core.journal.setSetting(key, { ...saved, reported: true } satisfies Origin);
    const thread = this.core.journal.getThread(turn.threadId);
    if (thread === null) return;
    const body = `${thread.title}: ${turn.status}\n${this.core.delegation.result(turn) ?? 'No text result was returned.'}`;
    try {
      await this.core.coordination.send({
        threadId: thread.id,
        to: { coreId: this.core.coordination.identity().coreId, threadId: saved.origin.threadId },
        text: body.length > 4000 ? `${body.slice(0, 3900)}\n[Truncated. Open the thread for the complete answer.]` : body,
        requestId: `spawn-result:${turn.id}`,
      });
    } catch (error) {
      this.core.log('warn', `thread ${thread.id}: its answer did not go back to ${saved.origin.threadId}: ${messageOf(error)}`);
    }
  }

  /** The thread's origin, when an agent started it. */
  originOf(threadId: ThreadId): ThreadLink | null {
    return (this.core.journal.getSetting(`${ORIGIN}${threadId}`) as Origin | undefined)?.origin ?? null;
  }

  private answer(id: ThreadId, turnId: string): AgentSpawn {
    const thread: ThreadSummary = withLoad(this.core, this.threads.require(id));
    const project = thread.projectId === null ? '' : this.core.journal.getProject(thread.projectId)?.name ?? thread.projectId;
    return { thread, turnId, address: { coreId: this.core.coordination.identity().coreId, threadId: id }, project };
  }

  private userPrompts(threadId: ThreadId): number {
    return (this.core.journal.db.query("SELECT count(*) AS n FROM messages WHERE thread_id = ? AND role = 'user'").get(threadId) as { n: number }).n;
  }

  /** A line of the starter's timeline, on its last turn. */
  private systemLine(threadId: ThreadId, part: Message['parts'][number]): void {
    const turnId = this.core.journal.listTurns(threadId).at(-1)?.id ?? newId('trn_');
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [part], state: 'complete', createdAt: Date.now() };
    this.core.journal.append({ type: 'thread.spawned', threadId, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }
}
