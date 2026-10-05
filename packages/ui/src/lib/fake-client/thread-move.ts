/** `threads.move` and `agent.move`, as the core's `threads/move.ts` answers them: the same refusals by field, the same placement. */
import { RpcErrorCode, type AgentMove, type Message, type MoveEnd, type MoveNotice, type Project, type Thread, type ThreadId, type ThreadSummary } from '@boite/contracts';
import { RpcFailure } from '../client';
import { missingFolder } from './checks';
import { archiveProject } from './project-archive';
import { fakeDraftFolder, fakeWorktree, toSummary } from './shared';
import { registerFakeWorktree } from './worktrees';
import type { FakeContext, FakeMethods } from './context';

/** The core's sentence, word for word, so a capture reads what the agent reads. */
export function fakeMoveNote(from: MoveEnd, to: MoveEnd, branch: string | null): string {
  return `This thread moved from project ${from.name} (${from.cwd}) to project ${to.name} (${to.cwd}). Your working directory is now ${whereOf(to, branch)}. Files you changed in the old folder stay there.\n\n`;
}

/** What the history of a thread the agent moved itself says, as the core's `agentMoveNote`. */
export function fakeAgentMoveNote(from: MoveEnd, to: MoveEnd, branch: string | null): string {
  return `You moved this thread from project ${from.name} (${from.cwd}) to project ${to.name} (${to.cwd}). Your working directory is now ${whereOf(to, branch)}.`;
}

function whereOf(to: MoveEnd, branch: string | null): string {
  return branch === null ? to.cwd : `${to.cwd} (a new git worktree on branch ${branch})`;
}

function refuse(message: string, data: Record<string, unknown>): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message, data });
}

/** As the core's `Phase`: `now` wants the whole family idle, `request` lets the thread's own turn run, `apply` runs once it ended. */
type Phase = 'now' | 'request' | 'apply';
type By = 'user' | 'agent';
const IN_FLIGHT = ['queued', 'running', 'waiting'];

function familyOf(ctx: FakeContext, thread: Thread): Thread[] {
  return [thread, ...[...ctx.threads.values()].filter((one) => one.parentThreadId === thread.id)];
}

function check(ctx: FakeContext, thread: Thread, projectId: string, stopBackground: boolean | undefined, phase: Phase): Project {
  const threadId = thread.id;
  if (thread.agentSessionId || thread.projectId === null) {
    throw refuse('a persistent agent session takes its work through Agents and cannot be moved', { threadId, field: 'threadId', expected: 'a conversation thread' });
  }
  if (thread.parentThreadId) {
    throw refuse('a sub-thread moves with its parent; move the parent thread instead', { threadId, parentThreadId: thread.parentThreadId, field: 'threadId', expected: 'a thread that is not a sub-thread' });
  }
  if (thread.archived) throw refuse('cannot move an archived thread', { threadId, field: 'threadId', expected: 'a thread that is not archived' });
  if (thread.incognito) throw refuse('an incognito conversation cannot be moved: it is erased when it is left', { threadId, field: 'threadId', expected: 'a conversation that is not incognito' });
  const target = ctx.projects.find((p) => p.id === projectId);
  if (!target) throw ctx.notFound('project', projectId);
  if (target.id === thread.projectId) {
    throw refuse(`thread ${threadId} is already in project ${target.name}`, { threadId, projectId, field: 'projectId', expected: 'another project than the thread\'s own' });
  }
  const busyNow = (one: Thread): boolean => {
    if (one.id === threadId && phase === 'request') return false;
    if (one.id === threadId && phase === 'apply') return ctx.inFlight.has(one.id) || one.status === 'running' || one.status === 'waiting';
    return IN_FLIGHT.includes(one.status) || ctx.inFlight.has(one.id);
  };
  const busy = familyOf(ctx, thread).find(busyNow);
  if (busy) {
    throw refuse(busy.id === threadId
      ? 'this thread has a turn running or queued; stop it before moving the thread'
      : `sub-thread ${busy.id} has a turn running or queued; stop it before moving the thread`, { threadId, busyThreadId: busy.id, reason: 'turn-in-flight', status: busy.status, expected: 'an idle thread' });
  }
  if (familyOf(ctx, thread).some((one) => (one.background?.length ?? 0) > 0) && stopBackground === undefined) {
    throw refuse(`the agent still runs work in the background in ${thread.cwd}; say whether to stop it`, { threadId, field: 'stopBackground', expected: `true to stop it, or false to leave it running in ${thread.cwd}` });
  }
  if (missingFolder(target.path)) {
    throw refuse(`the folder ${target.path} of project ${target.name} does not exist`, { threadId, projectId, path: target.path, field: 'projectId', expected: 'a project whose folder exists' });
  }
  return target;
}

function wantsWorktree(thread: Thread, target: Project): boolean {
  return thread.branch !== null && target.kind !== 'drafts' && target.repository !== false;
}

/** A line of the timeline from the core, on the thread's last turn. */
function systemMessage(ctx: FakeContext, thread: Thread, part: Message['parts'][number]): void {
  const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: thread.turns.at(-1)?.id ?? `turn-${++ctx.seq}`, role: 'system', parts: [part], state: 'complete', createdAt: ctx.now() };
  thread.messages.push(message);
  ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
  ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
}

function move(ctx: FakeContext, threadId: ThreadId, projectId: string, stopBackground: boolean | undefined, phase: Phase, by: By): ThreadSummary {
  if (stopBackground !== undefined && typeof stopBackground !== 'boolean') {
    throw refuse('threads.move.stopBackground must be a boolean', { threadId, field: 'stopBackground', expected: 'true, false or absent' });
  }
  const thread = ctx.thread(threadId);
  const target = check(ctx, thread, projectId, stopBackground, phase);
  // Whatever waited is done or overtaken: the row loses its "Moves to" line.
  forgetWaiting(ctx, thread);
  const placed = wantsWorktree(thread, target) ? fakeWorktree(target.path, thread.title, undefined, ctx.settings.worktreeStorage, target.id) : null;
  if (placed) registerFakeWorktree(ctx, target.id, placed);
  const cwd = placed?.path
    ?? (target.kind === 'drafts' ? fakeDraftFolder(target.path, thread.title, new Date(ctx.now()), new Set([...ctx.threads.values()].map((one) => one.cwd))) : target.path);
  const branch = placed?.branch ?? null;
  const branchNamingPending = placed?.namingPending ?? false;
  const source = ctx.projects.find((p) => p.id === thread.projectId);
  const from: MoveEnd = { projectId: thread.projectId ?? '', name: source?.name ?? thread.projectId ?? '', cwd: thread.cwd };
  const to: MoveEnd = { projectId: target.id, name: target.name, cwd };
  let answer = toSummary(thread);
  for (const one of familyOf(ctx, thread)) {
    one.branchNamingPending = branchNamingPending;
    if ((one.background?.length ?? 0) > 0 && stopBackground === true) ctx.setBackground(one, [], 'session-ended');
    // The core keeps only Codex's session, whose resume takes the new folder.
    const protocol = ctx.providers.find((p) => p.id === one.providerId)?.protocol;
    if (protocol !== 'codex-appserver' || one.sessionId === null) {
      one.sessionId = null;
      one.sessionGeneration = (one.sessionGeneration ?? 0) + 1;
      one.context = null;
      one.promptCache = null;
    }
    if (by === 'user') {
      const earlier = ctx.moveNotes.get(one.id);
      const origin = earlier?.from ?? { ...from, cwd: one.cwd };
      if (origin.cwd === cwd) ctx.moveNotes.delete(one.id);
      else ctx.moveNotes.set(one.id, { from: origin, to, note: fakeMoveNote(origin, to, branch), at: ctx.now() } satisfies MoveNotice);
    } else {
      // The agent asked and knows where it goes: nothing waits for its next message.
      ctx.moveNotes.delete(one.id);
    }
    one.projectId = target.id;
    one.cwd = cwd;
    one.branch = branch;
    one.pullRequest = null;
    const summary = ctx.touch(one);
    if (one.id === thread.id) answer = summary;
  }
  if (by === 'agent') {
    const notice: MoveNotice = { from, to, note: fakeAgentMoveNote(from, to, branch), at: ctx.now(), by: 'agent' };
    systemMessage(ctx, thread, { type: 'text', text: '', moved: notice });
  }
  if (target.archived === true) archiveProject(ctx, target.id, false);
  return structuredClone(answer);
}

/** A project named by id, by name (any case) or by its folder, as the core resolves `agent.move.project`. */
export function resolveProject(ctx: FakeContext, threadId: ThreadId, query: string, method = 'agent.move'): Project {
  const expected = 'the id, name or absolute folder of a project added to Boite';
  if (typeof query !== 'string' || query.trim().length === 0) throw refuse(`${method}.project must name a project`, { threadId, field: 'project', expected });
  const wanted = query.trim();
  const fold = (text: string): string => text.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
  const byId = ctx.projects.find((p) => p.id === wanted);
  const byPath = ctx.projects.find((p) => fold(p.path) === fold(wanted));
  const byName = ctx.projects.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());
  if (!byId && !byPath && byName.length > 1) {
    throw refuse(`${byName.length} projects are named ${wanted}; name one by its id or folder`, { threadId, field: 'project', project: wanted, candidates: byName.map((p) => ({ id: p.id, path: p.path })), expected: 'a project id or folder' });
  }
  const found = byId ?? byPath ?? byName[0];
  if (!found) throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `no project ${wanted} in Boite`, data: { threadId, field: 'project', project: wanted, expected } });
  return found;
}

function inFlight(ctx: FakeContext, thread: Thread): boolean {
  return IN_FLIGHT.includes(thread.status) || ctx.inFlight.has(thread.id);
}

/** The row hears its pending move without a new `updatedAt`, as the core's `announce`. */
function announce(ctx: FakeContext, thread: Thread): ThreadSummary {
  const summary = structuredClone(toSummary(thread));
  ctx.emit('thread.updated', summary);
  return structuredClone(summary);
}

function wait(ctx: FakeContext, thread: Thread, projectId: string, by: By, stopBackground: boolean | undefined): ThreadSummary {
  const at = ctx.now();
  ctx.waitingMoves.set(thread.id, { projectId, by, stopBackground, at });
  const project = ctx.projects.find((p) => p.id === projectId);
  thread.pendingMove = { projectId, project: project?.name ?? projectId, by, at };
  return announce(ctx, thread);
}

function forgetWaiting(ctx: FakeContext, thread: Thread): void {
  ctx.waitingMoves.delete(thread.id);
  thread.pendingMove = null;
}

/**
 * The move asked for during the turn, now that it ended, stopped or failed:
 * the user's keeps its note, the agent's does not. A refusal that appeared
 * since is a system line.
 */
export function applyWaitingMove(ctx: FakeContext, threadId: ThreadId): void {
  const waiting = ctx.waitingMoves.get(threadId);
  if (waiting === undefined) return;
  const thread = ctx.threads.get(threadId);
  ctx.waitingMoves.delete(threadId);
  try {
    move(ctx, threadId, waiting.projectId, waiting.stopBackground ?? false, 'apply', waiting.by);
  } catch (error) {
    if (!thread) return;
    thread.pendingMove = null;
    const name = ctx.projects.find((p) => p.id === waiting.projectId)?.name ?? waiting.projectId;
    const reason = error instanceof RpcFailure ? error.message : String(error);
    const who = waiting.by === 'agent' ? 'the agent' : 'the user';
    systemMessage(ctx, thread, { type: 'text', text: `The move to project ${name} ${who} asked for did not happen: ${reason}` });
    announce(ctx, thread);
  }
}

/** A waiting move goes with an archived thread, as the core's `forget`. */
export function dropWaitingMove(ctx: FakeContext, thread: Thread): void {
  forgetWaiting(ctx, thread);
}

export function threadMoveMethods(ctx: FakeContext) {
  return {
    'threads.move': async (params) => {
      const { threadId, projectId, stopBackground } = params;
      const thread = ctx.thread(threadId);
      if (!inFlight(ctx, thread)) return move(ctx, threadId, projectId, stopBackground, 'now', 'user');
      if (stopBackground !== undefined && typeof stopBackground !== 'boolean') {
        throw refuse('threads.move.stopBackground must be a boolean', { threadId, field: 'stopBackground', expected: 'true, false or absent' });
      }
      const target = check(ctx, thread, projectId, stopBackground, 'request');
      return wait(ctx, thread, target.id, 'user', stopBackground);
    },
    'threads.moveCancel': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (!ctx.waitingMoves.has(thread.id)) {
        throw refuse(`thread ${thread.id} has no move waiting for its turn to end`, { threadId: thread.id, field: 'threadId', expected: 'a thread with a pending move' });
      }
      forgetWaiting(ctx, thread);
      return announce(ctx, thread);
    },
    'agent.projects': async (params) => {
      const own = ctx.thread(params.threadId).projectId;
      return ctx.projects.filter((p) => p.archived !== true).map((p) => ({ id: p.id, name: p.name, path: p.path, repository: p.repository === true, drafts: p.kind === 'drafts', current: p.id === own }));
    },
    'agent.move': async (params): Promise<AgentMove> => {
      const { threadId } = params;
      const thread = ctx.thread(threadId);
      const target = resolveProject(ctx, threadId, params.project);
      check(ctx, thread, target.id, true, 'request');
      const stopsBackground = familyOf(ctx, thread).some((one) => (one.background?.length ?? 0) > 0);
      const answer = { threadId, projectId: target.id, project: target.name, projectPath: target.path, stopsBackground };
      if (inFlight(ctx, thread)) {
        wait(ctx, thread, target.id, 'agent', true);
        const plain = target.kind !== 'drafts' && !wantsWorktree(thread, target);
        return { ...answer, cwd: plain ? target.path : null, when: 'turn-end' };
      }
      const moved = move(ctx, threadId, target.id, true, 'apply', 'agent');
      return { ...answer, cwd: moved.cwd, when: 'done' };
    },
  } satisfies Partial<FakeMethods>;
}
