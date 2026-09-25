/** Permission requests and questions: asked by a turn, answered by the user. */
import { RpcErrorCode, type Message, type MessagePart, type PermissionRequest, type QuestionAnswer, type QuestionRequest, type Thread, type ThreadId, type Turn } from '@boite/contracts';
import { RpcFailure } from '../client';
import { checkAnswer, checkAsk } from './checks';
import { QUESTION_OPTIONS, QUESTION_TEXT } from './conversation';
import type { FakeContext, FakeMethods } from './context';

export async function askPermission(ctx: FakeContext, thread: Thread, turn: Turn, message: Message): Promise<void> {
  const requestId = `req-${++ctx.seq}`;
  const partIndex = message.parts.length;
  const part: MessagePart = {
    type: 'permission',
    requestId,
    toolName: 'Write',
    decision: null
  };
  message.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(part)
  });

  const request: PermissionRequest = {
    id: requestId,
    threadId: thread.id,
    turnId: turn.id,
    toolName: 'Write',
    input: { path: `${thread.cwd}\\notes.md`, contents: 'the thing you asked for' },
    description: 'Write a file inside the working directory',
    createdAt: ctx.now()
  };
  thread.status = 'waiting';
  ctx.touch(thread);
  ctx.emit('permission.requested', structuredClone(request));

  const decision = await new Promise<'allow' | 'deny'>((resolve) => {
    ctx.pendingPermissions.set(requestId, { request, resolve });
  });

  settlePermission(ctx, thread, message, partIndex, request, decision);
  thread.status = 'running';
  ctx.touch(thread);
}

export async function askQuestion(ctx: FakeContext, thread: Thread, turn: Turn, message: Message): Promise<void> {
  const questionId = `qst-${++ctx.seq}`;
  const partIndex = message.parts.length;
  const asked = {
    text: QUESTION_TEXT,
    options: QUESTION_OPTIONS,
    allowText: true,
    multiple: false
  };
  const part: MessagePart = { type: 'question', questionId, ...asked, answer: null };
  message.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: structuredClone(part)
  });

  const request: QuestionRequest = {
    id: questionId,
    threadId: thread.id,
    turnId: turn.id,
    ...asked,
    createdAt: ctx.now()
  };
  thread.status = 'waiting';
  ctx.touch(thread);
  ctx.emit('question.asked', structuredClone(request));

  const answer = await new Promise<QuestionAnswer | null>((resolve) => {
    ctx.pendingQuestions.set(questionId, { request, resolve });
  });

  settleQuestion(ctx, thread, message, partIndex, request, answer);
  thread.status = 'running';
  ctx.touch(thread);
}

/** The answer written into the part, then the event, whichever path answered. */
export function settleQuestion(
  ctx: FakeContext,
  thread: Thread,
  message: Message,
  partIndex: number,
  request: QuestionRequest,
  answer: QuestionAnswer | null
): void {
  const stored = message.parts[partIndex];
  if (stored && stored.type === 'question') stored.answer = answer;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: {
      type: 'question',
      questionId: request.id,
      text: request.text,
      options: request.options,
      allowText: request.allowText,
      multiple: request.multiple,
      ...(request.async === true ? { async: true } : {}),
      answer
    }
  });
  ctx.emit('question.answered', { questionId: request.id, threadId: thread.id, answer });
}

/**
 * The core's `askAsync`: the card goes on the running message, or on a new
 * assistant message of the last turn, and nothing waits on it. The answer
 * comes back as a prompt quoting the question, once the thread is free.
 */
export function askAsync(ctx: FakeContext, thread: Thread, turn: Turn, running: Message | null, text: string, labels: string[], multiple: boolean): string {
  const questionId = `qst-${++ctx.seq}`;
  const asked = {
    text,
    options: labels.map((label, index) => ({ id: String(index + 1), label })),
    allowText: true,
    multiple
  };
  let message = running;
  if (message === null) {
    message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'assistant', parts: [], state: 'complete', createdAt: ctx.now() };
    thread.messages.push(message);
    ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
  }
  const host = message;
  const partIndex = host.parts.length;
  const part: MessagePart = { type: 'question', questionId, ...asked, async: true, answer: null };
  host.parts.push(part);
  ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: host.id, partIndex, part: structuredClone(part) });
  const request: QuestionRequest = { id: questionId, threadId: thread.id, turnId: turn.id, ...asked, async: true, createdAt: ctx.now() };
  ctx.emit('question.asked', structuredClone(request));
  ctx.pendingQuestions.set(questionId, {
    request,
    resolve: (answer) => {
      settleQuestion(ctx, thread, host, partIndex, request, answer);
      if (answer === null) return;
      const picked = answer.optionIds.map((id) => asked.options.find((option) => option.id === id)?.label ?? id).join(', ');
      const reply = [picked, answer.text ?? ''].filter((line) => line.length > 0).join('\n');
      holdAnswer(ctx, thread, `> ${text}\n\n${reply}`);
    }
  });
  return questionId;
}

/** As the core's deferred answers: the ones given while a turn runs start one turn together after it. */
function holdAnswer(ctx: FakeContext, thread: Thread, prompt: string): void {
  const held = ctx.heldAnswers.get(thread.id);
  if (held) {
    held.push(prompt);
    return;
  }
  ctx.heldAnswers.set(thread.id, [prompt]);
  void flushAnswers(ctx, thread);
}

async function flushAnswers(ctx: FakeContext, thread: Thread): Promise<void> {
  for (let running = ctx.inFlight.get(thread.id); running; running = ctx.inFlight.get(thread.id)) {
    await running.done.catch(() => undefined);
  }
  const held = ctx.heldAnswers.get(thread.id) ?? [];
  ctx.heldAnswers.delete(thread.id);
  if (held.length > 0 && !thread.archived) ctx.startTurn(thread.id, held.join('\n\n'));
}

/** Writes the answer into the part and tells everyone, whichever path asked. */
export function settlePermission(
  ctx: FakeContext,
  thread: Thread,
  message: Message,
  partIndex: number,
  request: PermissionRequest,
  decision: 'allow' | 'deny'
): void {
  const stored = message.parts[partIndex];
  if (stored && stored.type === 'permission') stored.decision = decision;
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex,
    part: { type: 'permission', requestId: request.id, toolName: request.toolName, decision }
  });
  ctx.emit('permission.resolved', { requestId: request.id, threadId: thread.id, decision });
}

/**
 * What the core's recovery does to a thread whose turn it ends: every
 * request still waiting is settled and dropped, the question with a null
 * answer and the permission with a deny (`packages/core/src/threads.ts`).
 */
export function clearRequestsOf(ctx: FakeContext, threadId: ThreadId): void {
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (pending.request.threadId !== threadId || pending.request.async === true) continue;
    ctx.pendingQuestions.delete(questionId);
    ctx.emit('question.answered', { questionId, threadId, answer: null });
    pending.resolve(null);
  }
  for (const [requestId, pending] of [...ctx.pendingPermissions]) {
    if (pending.request.threadId !== threadId) continue;
    ctx.pendingPermissions.delete(requestId);
    ctx.emit('permission.resolved', { requestId, threadId, decision: 'deny' });
    pending.resolve('deny');
  }
}

export function requestMethods(ctx: FakeContext) {
  return {
    'permissions.list': async (params) => {
      const requests = [...ctx.pendingPermissions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'permissions.answer': async (params) => {
      const pending = ctx.pendingPermissions.get(params.requestId);
      if (!pending) throw ctx.notFound('permission request', params.requestId);
      ctx.pendingPermissions.delete(params.requestId);
      pending.resolve(params.decision);
      return { ok: true };
    },
    'questions.list': async (params) => {
      const requests = [...ctx.pendingQuestions.values()]
        .map((pending) => pending.request)
        .filter((request) => params.threadId === undefined || request.threadId === params.threadId)
        .sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(requests);
    },
    'questions.ask': async (params) => {
      const thread = ctx.thread(params.threadId);
      if (thread.archived) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot ask on an archived thread', data: { threadId: thread.id } });
      const asked = checkAsk(params);
      const turn = thread.turns.find((entry) => entry.status === 'running') ?? thread.turns.at(-1);
      if (!turn) {
        throw new RpcFailure({
          code: RpcErrorCode.Refused,
          message: 'the thread has no turn to ask in yet',
          data: { threadId: params.threadId }
        });
      }
      return { questionId: askAsync(ctx, thread, turn, null, asked.text, asked.labels, asked.multiple) };
    },
    'questions.answer': async (params) => {
      const pending = ctx.pendingQuestions.get(params.questionId);
      if (!pending) throw ctx.notFound('question', params.questionId);
      // Every refusal comes before the delete, so a refused answer leaves the card pending.
      checkAnswer(pending.request, params);
      ctx.pendingQuestions.delete(params.questionId);
      const text = params.text ?? '';
      const answer: QuestionAnswer =
        text.length > 0 ? { optionIds: params.optionIds, text } : { optionIds: params.optionIds };
      pending.resolve(answer);
      return { ok: true };
    },
  } satisfies Partial<FakeMethods>;
}
