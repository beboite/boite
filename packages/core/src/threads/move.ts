import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMove, Message, MoveEnd, MoveNotice, PendingMove, Project, ProjectId, Protocol, ThreadId, ThreadSummary } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import type { PlacedWorktree } from '../worktree.ts';
import { draftFolderName, makeDraftFolder } from './inputs.ts';
import { MOVE_NOTE_PREFIX, saveThread, withLoad } from './records.ts';

// The note lives with the row's other reads (`withLoad` shows it to clients).
export { MOVE_NOTE_PREFIX, pendingMoveNote as pendingMove } from './records.ts';

/**
 * Whether the agent's own session survives a change of folder. Codex's
 * `thread/resume` takes the new `cwd` with the thread id, so its session goes
 * on in the new folder. Claude files its transcripts under the folder it ran
 * in and pi scopes its session lookup by folder, so a resume there would find
 * nothing or start empty; ACP and the others make no promise. Those start a
 * fresh session whose first prompt carries the journal's history.
 */
export function keepsSessionAcrossFolders(protocol: Protocol | null): boolean {
  return protocol === 'codex-appserver';
}

function whereOf(to: MoveEnd, branch: string | null): string {
  return branch === null ? to.cwd : `${to.cwd} (a new git worktree on branch ${branch})`;
}

/** The sentence the agent reads before its next prompt. */
export function moveNote(from: MoveEnd, to: MoveEnd, branch: string | null): string {
  return `This thread moved from project ${from.name} (${from.cwd}) to project ${to.name} (${to.cwd}). Your working directory is now ${whereOf(to, branch)}.\n- Run every command and resolve every relative path from this new directory.\n- File contents, paths, git state and command results from earlier in this conversation describe the old folder: read files again here before relying on them.\n- Changes made in the old folder stayed there and were not carried over. Leave the old folder alone unless the user asks.\n- Follow this project's own instructions (CLAUDE.md, AGENTS.md or the like), not the old project's.\n\n`;
}

/** What a fresh session's history says about a move the agent asked for itself. */
export function agentMoveNote(from: MoveEnd, to: MoveEnd, branch: string | null): string {
  return `You moved this thread from project ${from.name} (${from.cwd}) to project ${to.name} (${to.cwd}). Your working directory is now ${whereOf(to, branch)}.`;
}

const IN_FLIGHT = ['queued', 'running', 'waiting'];

function checkStop(threadId: ThreadId, stopBackground: unknown): void {
  if (stopBackground !== undefined && typeof stopBackground !== 'boolean') {
    throw refused('threads.move.stopBackground must be a boolean', { threadId, field: 'stopBackground', expected: 'true, false or absent' });
  }
}

/**
 * What counts as busy when the thread moves:
 * - `now`: the thread and its sub-threads must be idle.
 * - `request`: asked from inside or during the thread's own turn, which is
 *   not in the way (the move waits for it); its sub-threads still are.
 * - `apply`: a waiting move, once the turn ended. A turn queued meanwhile
 *   runs after it, in the new folder.
 */
type Phase = 'now' | 'request' | 'apply';

/** A move waiting for the thread's turn to end, and how it will run. */
interface Waiting {
  projectId: ProjectId;
  by: 'user' | 'agent';
  stopBackground: boolean | undefined;
  at: number;
}

/**
 * `threads.move` and `agent.move`: a thread and its sub-threads change
 * project. Everything a refusal can come from is checked before anything is
 * made on disk; a new worktree made for the move is removed again when a
 * later step fails. The old folder is never touched. A thread whose turn is
 * in flight moves when the turn ends (`applyWaiting`), whoever asked.
 */
export class ThreadMove {
  /** Moves asked for while the thread's turn ran, applied when the turn ends. Memory only. */
  private readonly waiting = new Map<ThreadId, Waiting>();

  constructor(private readonly core: Core, private readonly threads: ThreadStore) {}

  /** The row's "Moves to ... after this turn", or null. */
  pendingOf(threadId: ThreadId): PendingMove | null {
    const waiting = this.waiting.get(threadId);
    if (waiting === undefined) return null;
    const project = this.core.journal.getProject(waiting.projectId);
    return { projectId: waiting.projectId, project: project?.name ?? waiting.projectId, by: waiting.by, at: waiting.at };
  }

  /**
   * `threads.move`. An idle thread moves on the spot. A thread whose own turn
   * runs, waits or is queued gets the move recorded and answered as
   * `pendingMove`; a second one replaces it.
   */
  async userMove(threadId: ThreadId, projectId: ProjectId, stopBackground?: boolean): Promise<ThreadSummary> {
    checkStop(threadId, stopBackground);
    const thread = this.threads.require(threadId);
    if (!this.inFlight(thread)) return this.move(threadId, projectId, stopBackground, 'now', 'user');
    const target = this.check(thread, projectId, stopBackground, 'request');
    await this.requireFolder(threadId, target);
    // The turn may have ended while the folder was looked at: then it moves now.
    if (!this.inFlight(this.threads.require(threadId))) return this.move(threadId, projectId, stopBackground, 'now', 'user');
    this.waiting.set(threadId, { projectId: target.id, by: 'user', stopBackground, at: Date.now() });
    return this.announce(threadId);
  }

  /** `threads.moveCancel`: the waiting move goes, the thread stays where it is. */
  cancel(threadId: ThreadId): ThreadSummary {
    this.threads.require(threadId);
    if (!this.waiting.delete(threadId)) {
      throw refused(`thread ${threadId} has no move waiting for its turn to end`, { threadId, field: 'threadId', expected: 'a thread with a pending move' });
    }
    return this.announce(threadId);
  }

  private inFlight(thread: ThreadSummary): boolean {
    return IN_FLIGHT.includes(thread.status) || this.threads.runner.handles.has(thread.id);
  }

  /** Every client hears the row with its pending move, which lives in memory and changes nothing stored. */
  private announce(threadId: ThreadId): ThreadSummary {
    const summary = withLoad(this.core, this.threads.require(threadId));
    this.core.bus.emit('thread.updated', summary);
    return summary;
  }

  async move(threadId: ThreadId, projectId: ProjectId, stopBackground: boolean | undefined, phase: Phase, by: 'user' | 'agent'): Promise<ThreadSummary> {
    checkStop(threadId, stopBackground);
    const thread = this.threads.require(threadId);
    const target = this.check(thread, projectId, stopBackground, phase);
    await this.requireFolder(threadId, target);
    // A thread that had a worktree of its own gets one in the target, the way
    // `threads.create` does with `worktree: {}`; a target that is no repository
    // gives it the project folder instead.
    const placed: PlacedWorktree | null = this.wantsWorktree(thread, target) ? await this.core.worktrees.add(threadId, target) : null;
    try {
      // Git took time: a turn may have started or the project changed meanwhile.
      const now = this.threads.require(threadId);
      const again = this.check(now, projectId, stopBackground, phase);
      const cwd = placed?.path
        ?? (again.kind === 'drafts' ? makeDraftFolder(again.path, draftFolderName(now.title, new Date())) : again.path);
      return this.write(now, again, cwd, placed?.branch ?? null, stopBackground === true, by, placed?.namingPending ?? false);
    } catch (error) {
      if (placed !== null) await this.core.worktrees.remove(threadId, target, placed);
      throw error;
    }
  }

  /**
   * `agent.move`: while the thread's turn runs the move waits for it to end
   * (`applyWaiting`); an idle thread moves on the spot. The agent asked, so
   * its background work stops with the move rather than being asked about.
   */
  async request(threadId: ThreadId, query: string): Promise<AgentMove> {
    const thread = this.threads.require(threadId);
    const target = this.resolve(threadId, query);
    this.check(thread, target.id, true, 'request');
    await this.requireFolder(threadId, target);
    const family = [thread, ...this.children(thread)];
    const stopsBackground = family.some((one) => (this.threads.agentState.background.get(one.id)?.length ?? 0) > 0);
    const answer = { threadId, projectId: target.id, project: target.name, projectPath: target.path, stopsBackground };
    if (this.inFlight(thread)) {
      this.waiting.set(threadId, { projectId: target.id, by: 'agent', stopBackground: true, at: Date.now() });
      this.announce(threadId);
      const plain = target.kind !== 'drafts' && !this.wantsWorktree(thread, target);
      return { ...answer, cwd: plain ? target.path : null, when: 'turn-end' };
    }
    const moved = await this.move(threadId, target.id, true, 'apply', 'agent');
    return { ...answer, cwd: moved.cwd, when: 'done' };
  }

  /**
   * Called by the turn runner once a turn's end is written, whether the turn
   * finished, stopped or failed: the move asked for during it happens now,
   * the user's with its note, the agent's without. A user move that did not
   * choose about background work (none ran when it was asked) keeps it. A
   * refusal that only appeared since (the project removed, a sub-thread
   * started) is a system message on the thread, so the user sees why the
   * thread stayed.
   */
  async applyWaiting(threadId: ThreadId): Promise<void> {
    const waiting = this.waiting.get(threadId);
    if (waiting === undefined) return;
    this.waiting.delete(threadId);
    try {
      await this.move(threadId, waiting.projectId, waiting.stopBackground ?? false, 'apply', waiting.by);
    } catch (error) {
      const reason = messageOf(error);
      const who = waiting.by === 'agent' ? 'the agent' : 'the user';
      this.core.log('warn', `thread ${threadId}: the move ${who} asked for did not happen: ${reason}`);
      if (this.core.journal.getThread(threadId) === null) return;
      const name = this.core.journal.getProject(waiting.projectId)?.name ?? waiting.projectId;
      this.systemMessage(threadId, { type: 'text', text: `The move to project ${name} ${who} asked for did not happen: ${reason}` });
      // The row loses its "Moves to ..." line.
      this.announce(threadId);
    }
  }

  /** A waiting move goes with an archived or removed thread. */
  forget(threadId: ThreadId): void {
    this.waiting.delete(threadId);
  }

  /** A project named by id, by name (any case) or by its absolute folder, among the ones the owner added. */
  private resolve(threadId: ThreadId, query: string): Project {
    return this.core.projects.find(query, 'agent.move', 'project', { threadId });
  }

  private wantsWorktree(thread: ThreadSummary, target: Project): boolean {
    return thread.branch !== null && target.kind !== 'drafts' && existsSync(join(target.path, '.git'));
  }

  private async requireFolder(threadId: ThreadId, target: Project): Promise<void> {
    const present = await stat(target.path).then((found) => found.isDirectory(), () => false);
    if (!present) {
      throw refused(`the folder ${target.path} of project ${target.name} does not exist`, {
        threadId, projectId: target.id, path: target.path, field: 'projectId', expected: 'a project whose folder exists',
      });
    }
  }

  /** Every refusal, by field, before anything is made. Answers the target project. */
  private check(thread: ThreadSummary, projectId: ProjectId, stopBackground: boolean | undefined, phase: Phase): Project {
    const threadId = thread.id;
    if (thread.agentSessionId || thread.projectId === null) {
      throw refused('a persistent agent session takes its work through Agents and cannot be moved', { threadId, field: 'threadId', expected: 'a conversation thread' });
    }
    if (thread.parentThreadId) {
      throw refused('a sub-thread moves with its parent; move the parent thread instead', {
        threadId, parentThreadId: thread.parentThreadId, field: 'threadId', expected: 'a thread that is not a sub-thread',
      });
    }
    if (thread.archived) throw refused('cannot move an archived thread', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
    if (thread.incognito) {
      throw refused('an incognito conversation cannot be moved: it is erased when it is left', { threadId, field: 'threadId', expected: 'a conversation that is not incognito' });
    }
    const target = this.core.projects.require(projectId);
    if (target.id === thread.projectId) {
      throw refused(`thread ${threadId} is already in project ${target.name}`, { threadId, projectId, field: 'projectId', expected: 'another project than the thread\'s own' });
    }
    const busyNow = (one: ThreadSummary): boolean => {
      if (one.id === threadId && phase === 'request') return false;
      if (one.id === threadId && phase === 'apply') return this.threads.runner.handles.has(one.id) || one.status === 'running' || one.status === 'waiting';
      return IN_FLIGHT.includes(one.status) || this.threads.runner.handles.has(one.id);
    };
    const busy = [thread, ...this.children(thread)].find(busyNow);
    if (busy !== undefined) {
      throw refused(busy.id === threadId
        ? 'this thread has a turn running or queued; stop it before moving the thread'
        : `sub-thread ${busy.id} has a turn running or queued; stop it before moving the thread`, {
        threadId, busyThreadId: busy.id, reason: 'turn-in-flight', status: busy.status, expected: 'an idle thread',
      });
    }
    const working = [thread, ...this.children(thread)].some((one) => (this.threads.agentState.background.get(one.id)?.length ?? 0) > 0);
    if (working && stopBackground === undefined) {
      throw refused(`the agent still runs work in the background in ${thread.cwd}; say whether to stop it`, {
        threadId, field: 'stopBackground', expected: `true to stop it, or false to leave it running in ${thread.cwd}`,
      });
    }
    return target;
  }

  private children(thread: ThreadSummary): ThreadSummary[] {
    return this.core.journal.listThreads(thread.projectId ?? undefined).filter((one) => one.parentThreadId === thread.id);
  }

  private write(thread: ThreadSummary, target: Project, cwd: string, branch: string | null, stopBackground: boolean, by: 'user' | 'agent', branchNamingPending: boolean): ThreadSummary {
    const source = this.core.journal.getProject(thread.projectId ?? '');
    const from: MoveEnd = { projectId: thread.projectId ?? '', name: source?.name ?? thread.projectId ?? '', cwd: thread.cwd };
    const to: MoveEnd = { projectId: target.id, name: target.name, cwd };
    const children = this.children(thread);
    // Whatever waited is done or overtaken: the row loses its "Moves to" line.
    this.waiting.delete(thread.id);
    let saved: ThreadSummary | null = null;
    for (const one of [thread, ...children]) {
      // The warm process goes now unless it holds background work the user
      // chose to keep: that work lives on in the old folder until the next
      // turn starts the agent in the new one.
      const holding = (this.threads.agentState.background.get(one.id)?.length ?? 0) > 0;
      if (!holding || stopBackground) {
        this.threads.releaseAgent(one.id);
        if (holding) this.threads.agentState.noteBackground(one.id, []);
      }
      const next = this.moved(one, target.id, cwd, branch);
      next.branchNamingPending = branchNamingPending;
      if (by === 'user') this.noteMove(one.id, { ...from, cwd: one.cwd }, to, branch);
      // The agent asked and knows where it goes: nothing waits for its next message.
      else this.core.journal.deleteSetting(`${MOVE_NOTE_PREFIX}${one.id}`);
      const summary = saveThread(this.core, next, 'thread.moved');
      this.followQueued(next);
      if (one.id === thread.id) saved = summary;
    }
    if (by === 'agent') {
      const notice: MoveNotice = { from, to, note: agentMoveNote(from, to, branch), at: Date.now(), by: 'agent' };
      this.systemMessage(thread.id, { type: 'text', text: '', moved: notice });
    }
    // A thread moved into a project put away says the project is in use again.
    if (target.archived === true) this.core.projects.archive(target.id, false);
    return saved ?? this.threads.require(thread.id);
  }

  /**
   * A turn queued before the move took the session it would resume from the
   * thread; it runs in the new folder, so it takes the moved thread's session.
   */
  private followQueued(thread: ThreadSummary): void {
    for (const turn of this.core.journal.listTurns(thread.id)) {
      if (turn.status !== 'queued' || turn.execution === undefined) continue;
      const { sessionResumeAt: _dropped, ...execution } = turn.execution;
      const next = { ...turn, execution: { ...execution, sessionId: thread.sessionId, sessionGeneration: thread.sessionGeneration ?? 0 } };
      this.core.journal.append({ type: 'turn.moved', threadId: thread.id, version: 1, payload: next }, () => this.core.journal.putTurn(next));
    }
  }

  /** A line of the timeline from the core, on the thread's last turn. */
  private systemMessage(threadId: ThreadId, part: Message['parts'][number]): void {
    const turnId = this.core.journal.listTurns(threadId).at(-1)?.id ?? newId('trn_');
    const message: Message = { id: newId('msg_'), threadId, turnId, role: 'system', parts: [part], state: 'complete', createdAt: Date.now() };
    this.core.journal.append({ type: 'thread.moved.note', threadId, version: 1, payload: message }, () => this.core.journal.putMessage(message));
    this.core.bus.emit('message.started', message);
    this.core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
  }

  /**
   * The row in its new place. A session that cannot follow the folder is
   * dropped: the next turn starts a fresh one seeded with the journal's
   * history, as after an account switch. The warm process is keyed by folder
   * in every driver, so the next turn never reuses one started in the old one.
   */
  private moved(thread: ThreadSummary, projectId: ProjectId, cwd: string, branch: string | null): ThreadSummary {
    let protocol: Protocol | null = null;
    try {
      protocol = this.core.providers.require(thread.providerId).protocol;
    } catch {
      protocol = null;
    }
    const keep = keepsSessionAcrossFolders(protocol) && thread.sessionId !== null;
    return {
      ...thread,
      projectId,
      cwd,
      branch,
      ...(keep ? {} : {
        sessionId: null,
        sessionResumeAt: null,
        sessionGeneration: (thread.sessionGeneration ?? 0) + 1,
        context: null,
        promptCache: null,
      }),
    };
  }

  /**
   * The pending note, kept in the journal so a restart before the next
   * message does not lose it. Several moves keep the first origin; a thread
   * back in the folder it started from has nothing to explain.
   */
  private noteMove(threadId: ThreadId, from: MoveEnd, to: MoveEnd, branch: string | null): void {
    const key = `${MOVE_NOTE_PREFIX}${threadId}`;
    const earlier = this.core.journal.getSetting(key) as MoveNotice | undefined;
    const origin = earlier?.from ?? from;
    if (origin.cwd === to.cwd) {
      this.core.journal.deleteSetting(key);
      return;
    }
    const notice: MoveNotice = { from: origin, to, note: moveNote(origin, to, branch), at: Date.now() };
    this.core.journal.setSetting(key, notice);
  }
}
