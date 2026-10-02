/** Tool-free side questions and their transient answers for the in-memory client. */
import { sideQuestionSnapshot, supportsSideQuestions, RpcErrorCode, type Message, type Thread, type ThreadSummary, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { checkRunnable } from './checks';
import type { FakeContext, FakeMethods } from './context';
import { refusal } from './shared';
import { requireFakeCwd } from './worktrees';

interface SideRequest { requestId: string; timer: ReturnType<typeof setTimeout> }
const sideRequests = new WeakMap<FakeContext, Map<string, SideRequest>>();

interface SideResult { requestId: string; source: Thread; question: string; answer: string; timer: ReturnType<typeof setTimeout> }
const sideResults = new WeakMap<FakeContext, Map<string, SideResult>>();
function forgetSide(ctx: FakeContext, threadId: string, requestId?: string): void {
  const results = sideResults.get(ctx), held = results?.get(threadId);
  if (held && (requestId === undefined || held.requestId === requestId)) { clearTimeout(held.timer); results!.delete(threadId); }
}

export function cancelSide(ctx: FakeContext, threadId: string, requestId?: string): void {
  forgetSide(ctx, threadId, requestId);
  const requests = sideRequests.get(ctx), pending = requests?.get(threadId);
  if (!pending || (requestId !== undefined && pending.requestId !== requestId)) return;
  clearTimeout(pending.timer);
  requests!.delete(threadId);
  ctx.emit('thread.btw', { threadId, requestId: pending.requestId, answer: null, error: 'side request cancelled' });
}

/** Pending inference and retained answers both protect a conversation from automatic archive. */
export function hasActiveSideQuestion(ctx: FakeContext, threadId: string): boolean {
  return sideRequests.get(ctx)?.has(threadId) === true || sideResults.get(ctx)?.has(threadId) === true;
}

export function retainedFamilyIds(ctx: FakeContext, threadId: string): Set<string> {
  const ids = new Set([threadId]);
  let size = 0;
  while (size !== ids.size) {
    size = ids.size;
    for (const thread of ctx.threads.values()) {
      if (thread.parentThreadId && ids.has(thread.parentThreadId)) ids.add(thread.id);
    }
  }
  return ids;
}

export function cancelFamilySideQuestions(ctx: FakeContext, threadId: string): void {
  for (const id of retainedFamilyIds(ctx, threadId)) cancelSide(ctx, id);
}

export function closeSideQuestions(ctx: FakeContext): void {
  const requests = sideRequests.get(ctx), results = sideResults.get(ctx);
  for (const pending of requests?.values() ?? []) clearTimeout(pending.timer);
  requests?.clear();
  sideRequests.delete(ctx);
  for (const result of results?.values() ?? []) clearTimeout(result.timer);
  results?.clear();
  sideResults.delete(ctx);
}

function requireParent(ctx: FakeContext, thread: Thread): void {
  const seen = new Set([thread.id]);
  let parentId = thread.parentThreadId;
  while (parentId) {
    const parent = ctx.threads.get(parentId);
    if (!parent || parent.archived || seen.has(parentId)) {
      throw refusal('threads.btw.threadId: expected a conversation whose parent is not archived or being deleted', { threadId: thread.id, parentThreadId: parentId });
    }
    seen.add(parentId);
    parentId = parent.parentThreadId;
  }
}

export function sideQuestionMethods(ctx: FakeContext, fork: (source: Thread, messages: Message[]) => ThreadSummary) {
  return {
    'threads.btw.cancel': async ({ threadId, requestId }) => {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'threads.btw.cancel.requestId: expected 8 to 128 URL-safe characters' });
      ctx.thread(threadId); cancelSide(ctx, threadId, requestId); return { ok: true };
    },
    'threads.btw.fork': async ({ threadId, requestId }) => {
      const current = ctx.thread(threadId), held = sideResults.get(ctx)?.get(threadId);
      requireFakeCwd(ctx, current);
      requireParent(ctx, current);
      if (current.archived || !held || held.requestId !== requestId) throw refusal('threads.btw.fork.requestId: expected an available completed side answer');
      const source = held.source;
      if (current.cwd !== source.cwd || current.projectId !== source.projectId) throw refusal('threads.btw.fork.threadId: the conversation moved since the side question');
      if (source.agentSessionId || source.projectId === null) throw refusal('threads.btw.fork.threadId: expected a conversation thread');
      if (!ctx.projects.some(project => project.id === source.projectId)) throw ctx.notFound('project', source.projectId);
      if (!ctx.providers.some(provider => provider.id === source.providerId)) throw ctx.notFound('provider', source.providerId);
      if (!ctx.accounts.some(account => account.id === source.accountId)) throw ctx.notFound('account', source.accountId);
      const now = ctx.now(), turnId = `turn-${++ctx.seq}`;
      const sideTurn: Turn = { id: turnId, threadId, status: 'done', queuedAt: now, startedAt: now, finishedAt: now, usage: null, error: null };
      const messages: Message[] = [
        ...source.messages,
        { id: `m-${++ctx.seq}`, threadId, turnId, role: 'user', parts: [{ type: 'text', text: held.question }], state: 'complete', createdAt: now },
        { id: `m-${++ctx.seq}`, threadId, turnId, role: 'assistant', parts: [{ type: 'text', text: held.answer }], state: 'complete', createdAt: now },
      ];
      const result = fork({ ...source, turns: [...source.turns.map(turn => ({ ...turn, checkpoint: null })), sideTurn] }, messages);
      forgetSide(ctx, threadId, requestId);
      return result;
    },
    'threads.btw': async ({ threadId, question, requestId }) => {
      if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'threads.btw.requestId: expected 8 to 128 URL-safe characters' });
      if (typeof question !== 'string' || !question.trim() || question.length > 12_000) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'threads.btw.question: expected 1 to 12000 characters' });
      }
      const thread = ctx.thread(threadId);
      requireFakeCwd(ctx, thread);
      if (thread.archived) throw refusal('threads.btw.threadId: expected a thread that is not archived');
      requireParent(ctx, thread);
      const provider = ctx.providers.find(entry => entry.id === thread.providerId)!;
      checkRunnable(provider, ctx.accounts.find(entry => entry.id === thread.accountId)!);
      if (!supportsSideQuestions(provider.protocol)) throw refusal(`threads.btw: ${provider.name} does not support tool-free side questions`);
      const requests = sideRequests.get(ctx) ?? new Map<string, SideRequest>();
      sideRequests.set(ctx, requests);
      if (requests.has(threadId)) throw refusal('a side question is already being answered for this thread');
      forgetSide(ctx, threadId);
      const snapshot = sideQuestionSnapshot(thread.messages), turnIds = new Set(snapshot.map(message => message.turnId));
      const source = structuredClone({ ...thread, messages: snapshot, turns: thread.turns.filter(turn => turnIds.has(turn.id)) });
      const pending: SideRequest = { requestId, timer: setTimeout(() => {
        if (requests.get(threadId) !== pending) return;
        requests.delete(threadId);
        let results = sideResults.get(ctx);
        if (!results) { results = new Map(); sideResults.set(ctx, results); }
        if (results.size >= 64) forgetSide(ctx, results.keys().next().value!);
        const expiry = setTimeout(() => forgetSide(ctx, threadId, requestId), 10 * 60_000);
        expiry.unref?.();
        results.set(threadId, { requestId, source, question: question.trim(), answer: `Side answer: ${question.trim()}`, timer: expiry });
        ctx.emit('thread.btw', { threadId, requestId, answer: `Side answer: ${question.trim()}`, error: null });
      }, 0) };
      requests.set(threadId, pending);
      return { requestId };
    },
  } satisfies Partial<FakeMethods>;
}
