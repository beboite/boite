import type { Attachment, RpcParams, Turn } from '@boite/contracts';
import type { FakeContext } from './context';
import { checkRunnable } from './checks';
import { refusal } from './shared';
import { requireFakeCwd } from './worktrees';

/** A fixture for an accepted prompt whose core stopped before its provider ran. */
export function holdAfterRestart(ctx: FakeContext, threadId: string, prompt: string): Turn {
  const thread = ctx.thread(threadId);
  if (['running', 'waiting', 'queued'].includes(thread.status)) throw refusal('this thread already has an in-flight turn');
  const now = ctx.now();
  const turn: Turn = {
    id: `turn-${++ctx.seq}`, threadId, status: 'queued', queuedAt: now, startedAt: null, finishedAt: null, usage: null, error: null,
    queueHold: { reason: 'core-restarted', since: now },
    execution: { providerId: thread.providerId, accountId: thread.accountId, model: thread.model, effort: thread.effort,
      speed: thread.speed ?? null, permissionMode: thread.permissionMode, sessionId: thread.sessionId,
      sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0 },
  };
  thread.turns.push(turn);
  const message = { id: `m-${++ctx.seq}`, threadId, turnId: turn.id, role: 'user' as const, state: 'complete' as const, parts: [{ type: 'text' as const, text: prompt }], createdAt: now };
  thread.messages.push(message);
  thread.status = 'queued';
  ctx.scheduler.queued.push({ turnId: turn.id, threadId, queuedAt: now, position: ctx.scheduler.queued.length, queueHold: turn.queueHold });
  ctx.emitToThread(threadId, 'message.started', structuredClone(message));
  ctx.emit('scheduler.updated', structuredClone(ctx.scheduler));
  ctx.touch(thread);
  return structuredClone(turn);
}

export async function recoverTurn(ctx: FakeContext, params: RpcParams<'turns.recover'>): Promise<Turn> {
  const thread = ctx.thread(params.threadId);
  if (params.action !== 'resume' && params.action !== 'discard') throw refusal('action must be resume or discard');
  const turn = thread.turns.find(entry => entry.id === params.turnId);
  if (!turn) throw ctx.notFound('turnId', params.turnId);
  if (turn.status !== 'queued' || !turn.queueHold) return structuredClone(turn);
  if (params.action === 'discard') {
    await ctx.stopTurn(thread.id);
    return structuredClone(turn);
  }
  if (thread.archived || thread.parentThreadId || thread.agentSessionId || !turn.execution || turn.execution.operation) throw refusal('only an unsent conversation prompt can be resumed');
  requireFakeCwd(ctx, thread);
  const provider = ctx.providers.find(entry => entry.id === turn.execution!.providerId);
  const account = ctx.accounts.find(entry => entry.id === turn.execution!.accountId);
  if (!provider || !account || account.providerId !== provider.id) throw refusal('the saved provider and account must be available');
  checkRunnable(provider, account);
  const input = thread.messages.find(message => message.turnId === turn.id && message.role === 'user');
  const text = input?.parts.find(part => part.type === 'text');
  const attachments: Attachment[] = (input?.parts ?? []).flatMap((part): Attachment[] => part.type === 'image'
    ? [{ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt }]
    : part.type === 'file' ? [{ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name }] : []);
  return ctx.startTurn(thread.id, text?.type === 'text' ? text.displayText ?? text.text : '', attachments, undefined, undefined, turn, text?.type === 'text' ? text.previewReferences ?? [] : []);
}
