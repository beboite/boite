/** The turn engine: start, stream and stop a turn, the way the echo driver answers. */
import { previewPrompt, RpcErrorCode, type AgentLetter, type Attachment, type Message, type MessagePart, type PreviewReference, type Thread, type ThreadId, type Turn, type Usage } from '@boite/contracts';
import { decodedBytes } from '../attachments';
import { RpcFailure } from '../client';
import { DIFF_NEW, DIFF_OLD, DIFF_PATH, DOC_TEXT, DOC_TITLE, IMAGE_BASE64, ASYNC_QUESTION_OPTIONS, ASYNC_QUESTION_TEXT, SPAWN_MARKER } from './conversation';
import { FAKE_CONTEXT_FLOOR, FAKE_CONTEXT_PER_TURN, FAKE_CONTEXT_WINDOW } from './providers';
import { addUsage, chunkText, ECHO_COMMANDS, emptyUsage, SHOUT } from './shared';
import { pauseActivity } from './activity';
import { askPermission, askQuestion, askAsync } from './requests';
import { backgroundShell, streamToolInput, runTool, documentTool, spawnProcess } from './turn-tools';
import { delegationConfig, pumpDelegation } from './delegation';
import type { FakeContext } from './context';

export async function stopTurn(ctx: FakeContext, threadId: ThreadId): Promise<boolean> {
  pauseActivity(ctx, ctx.thread(threadId));
  const running = ctx.inFlight.get(threadId);
  let stopped = running !== undefined;
  if (running) running.cancelled = true;
  for (const [requestId, pending] of [...ctx.pendingPermissions]) {
    if (pending.request.threadId !== threadId) continue;
    stopped = true;
    ctx.pendingPermissions.delete(requestId);
    pending.resolve('deny');
  }
  for (const [questionId, pending] of [...ctx.pendingQuestions]) {
    if (pending.request.threadId !== threadId || pending.request.async === true) continue;
    stopped = true;
    ctx.pendingQuestions.delete(questionId);
    pending.resolve(null);
  }
  await running?.done;
  return stopped;
}

export function startTurn(ctx: FakeContext, threadId: ThreadId, prompt: string, attachments: Attachment[] = [], operation?: 'compact' | 'delegation', activityKind?: 'goal' | 'loop', queuedTurn?: Turn, previewReferences: PreviewReference[] = []): Turn {
  // The real transport serializes Svelte proxies before they reach the core.
  previewReferences = JSON.parse(JSON.stringify(previewReferences)) as PreviewReference[];
  const thread = ctx.thread(threadId);
  if (thread.archived) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'cannot start a turn on an archived thread', data: { threadId } });
  }
  if ((!queuedTurn && ['queued', 'running', 'waiting'].includes(thread.status)) || (queuedTurn && (thread.status !== 'queued' || queuedTurn.status !== 'queued')) || ctx.inFlight.has(threadId)) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'this thread already has an in-flight turn', data: { threadId } });
  }
  // The agent names what it takes on its first turn, the way the echo driver
  // does: the list is the agent's, so it only exists once one has run.
  if (thread.commands.length === 0) {
    thread.commands = structuredClone(ECHO_COMMANDS);
    ctx.emitToThread(threadId, 'thread.commands', {
      threadId,
      commands: structuredClone(thread.commands)
    });
  }

  const at = ctx.now();
  const execution: NonNullable<Turn['execution']> = {
      providerId: thread.providerId, accountId: thread.accountId, model: thread.model,
      effort: thread.effort, speed: thread.speed ?? null, permissionMode: thread.permissionMode, sessionId: thread.sessionId,
      sessionGeneration: thread.sessionGeneration ?? 0, selectionVersion: thread.selectionVersion ?? 0,
      ...(operation ? { operation } : {}),
  };
  const turn: Turn = queuedTurn ?? {
    id: `turn-${++ctx.seq}`, threadId, status: 'running', queuedAt: at,
    startedAt: at, finishedAt: null, usage: null, error: null, execution
  };
  if (queuedTurn) Object.assign(turn, { status: 'running', startedAt: at, execution });
  else thread.turns.push(turn);

  const user: Message = {
    id: `m-${++ctx.seq}`,
    threadId,
    turnId: turn.id,
    role: 'user',
    // The images ride after the text, the order the core journals them in.
    parts: [
      { type: 'text', text: activityKind ? `/${activityKind} ${prompt}` : previewPrompt(prompt, previewReferences), ...(previewReferences.length ? { displayText: prompt, previewReferences: structuredClone(previewReferences) } : {}), ...(activityKind ? { activity: { kind: activityKind, iteration: (thread.activity?.[activityKind]?.iterations ?? 0) + 1 } } : {}) },
      ...attachments.map((attachment): MessagePart => attachment.kind === 'file' ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name } : ({
        type: 'image',
        mimeType: attachment.mimeType,
        data: attachment.data,
        alt: attachment.name
      }))
    ],
    state: 'complete',
    createdAt: at
  };
  if (!activityKind && !operation && thread.activity) {
    if (thread.activity.tasks.length && thread.activity.tasks.every(task => task.status === 'completed')) thread.activity.tasksDismissed = true;
    if (thread.activity.goal?.status === 'complete') thread.activity.goal.dismissed = true;
    ctx.publishActivity(thread);
  }
  thread.messages.push(user);
  ctx.emitToThread(threadId, 'message.started', structuredClone(user));
  ctx.emitToThread(threadId, 'message.completed', {
    threadId,
    messageId: user.id,
    state: 'complete'
  });

  thread.status = 'running';
  thread.sessionId = thread.sessionId ?? `sess-${turn.id}`;
  ctx.touch(thread);
  ctx.emit('turn.started', structuredClone(turn));
  pushScheduler(ctx, turn, 'running');

  const record = { cancelled: false, done: Promise.resolve() };
  record.done = stream(ctx, thread, turn, prompt, record, attachments, previewPrompt(prompt, previewReferences));
  ctx.inFlight.set(threadId, record);

  return structuredClone(turn);
}

async function stream(
  ctx: FakeContext,
  thread: Thread,
  turn: Turn,
  prompt: string,
  record: { cancelled: boolean },
  attachments: Attachment[] = [],
  modelPrompt: string = prompt
): Promise<void> {
  const compactAfter = Math.max(1, Math.floor((thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) / 4));
  const message: Message = {
    id: `m-${++ctx.seq}`,
    threadId: thread.id,
    turnId: turn.id,
    role: 'assistant',
    parts: [{ type: 'thinking', text: '' }],
    state: 'streaming',
    createdAt: ctx.now()
  };
  thread.messages.push(message);
  ctx.emitToThread(thread.id, 'message.started', structuredClone(message));

  // The reasoning first, in two deltas, the way a provider streams a thinking block.
  const reasoning = `thinking about: ${modelPrompt}`;
  for (const piece of chunkText(reasoning, 2, ctx.chunkSize)) {
    if (record.cancelled || piece.length === 0) break;
    await ctx.pause();
    const part = message.parts[0];
    if (part && part.type === 'thinking') part.text += piece;
    ctx.emitToThread(thread.id, 'message.delta', {
      threadId: thread.id,
      messageId: message.id,
      partIndex: 0,
      text: piece
    });
  }

  const textIndex = message.parts.length;
  message.parts.push({ type: 'text', text: '' });
  ctx.emitToThread(thread.id, 'message.part', {
    threadId: thread.id,
    messageId: message.id,
    partIndex: textIndex,
    part: { type: 'text', text: '' }
  });

  // `/shout <text>` comes back in capitals, the one command the fake acts on.
  const shouted = prompt.startsWith(`/${SHOUT} `) ? prompt.slice(SHOUT.length + 2) : null;
  const echoed = shouted === null ? modelPrompt : modelPrompt.slice(SHOUT.length + 2).toUpperCase();

  // An image is named back the way the echo driver names it, format and
  // weight first, then the prompt itself is echoed.
  const reply =
    attachments
      .map(
        (attachment) =>
          `[${attachment.kind} ${attachment.mimeType}, ${decodedBytes(attachment.data)} bytes${attachment.name === null ? '' : `, ${attachment.name}`
          }] `
      )
      .join('') + echoed;

  for (const piece of chunkText(reply, 5, ctx.chunkSize)) {
    if (record.cancelled) break;
    await ctx.pause();
    const part = message.parts[textIndex];
    if (part && part.type === 'text') part.text += piece;
    ctx.emitToThread(thread.id, 'message.delta', {
      threadId: thread.id,
      messageId: message.id,
      partIndex: textIndex,
      text: piece
    });
  }

  if (!record.cancelled && prompt.includes('[permission]')) {
    await askPermission(ctx, thread, turn, message);
  }
  // The bare word, like the echo driver: the fake agent asks one question.
  if (!record.cancelled && /\bquestion\b/.test(prompt)) {
    await askQuestion(ctx, thread, turn, message);
  }
  // `boite ask`: a card the agent does not wait on, answered into the next prompt.
  if (!record.cancelled && prompt.includes('[ask]')) {
    askAsync(ctx, thread, turn, message, ASYNC_QUESTION_TEXT, ASYNC_QUESTION_OPTIONS, false);
  }
  if (!record.cancelled && prompt.includes('[background]')) {
    await backgroundShell(ctx, thread, message);
  }
  if (!record.cancelled && prompt.includes('[tool-stream]')) {
    await streamToolInput(ctx, thread, message);
  }
  if (!record.cancelled && prompt.includes('[tool]')) {
    await runTool(ctx, thread, message);
  }
  if (!record.cancelled && prompt.includes('[diff]')) {
    // The edit lands in the working tree, so the file it names opens.
    ctx.files.set(DIFF_PATH, DIFF_NEW);
    await documentTool(ctx, thread, message, 'Edit', { file_path: DIFF_PATH }, 'edited 1 file', [
      { kind: 'diff', path: DIFF_PATH, oldText: DIFF_OLD, newText: DIFF_NEW }
    ]);
  }
  if (!record.cancelled && prompt.includes('[doc]')) {
    await documentTool(ctx, thread, message, 'Read', { file_path: DOC_TITLE }, `read ${DOC_TITLE}`, [
      { kind: 'markdown', title: DOC_TITLE, text: DOC_TEXT }
    ]);
  }
  if (!record.cancelled && prompt.includes('[image]')) {
    await documentTool(ctx, thread, message, 'Screenshot', { region: 'window' }, 'captured the window', [
      { kind: 'image', mimeType: 'image/png', data: IMAGE_BASE64, alt: 'one pixel' }
    ]);
  }
  const spawn = SPAWN_MARKER.exec(prompt);
  if (!record.cancelled && spawn && spawn[1]) {
    await spawnProcess(ctx, thread, spawn[1]);
  }

  if (!record.cancelled && prompt === '[compact]') {
    const part: MessagePart = { type: 'compaction', trigger: 'manual', preTokens: thread.context?.tokens ?? null, postTokens: compactAfter };
    const partIndex = message.parts.length;
    message.parts.push(part);
    ctx.emitToThread(thread.id, 'message.part', { threadId: thread.id, messageId: message.id, partIndex, part });
  }
  message.state = 'complete';
  ctx.emitToThread(thread.id, 'message.completed', {
    threadId: thread.id,
    messageId: message.id,
    state: 'complete'
  });

  const usage: Usage = {
    inputTokens: Math.max(1, Math.ceil(modelPrompt.length / 4)),
    outputTokens: Math.max(1, Math.ceil(modelPrompt.length / 4)),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsdEquivalent: Math.round(modelPrompt.length * 0.02) / 1000
  };
  turn.status = record.cancelled ? 'stopped' : 'done';
  turn.finishedAt = ctx.now();
  turn.usage = usage;
  ctx.usage.set(thread.id, addUsage(ctx.usage.get(thread.id) ?? emptyUsage(), usage));
  ctx.finished.push({ at: turn.finishedAt, threadId: thread.id, title: thread.title, projectId: thread.projectId, providerId: thread.providerId, model: thread.model, usage });

  ctx.inFlight.delete(thread.id);
  thread.status = 'idle';
  thread.unread = !ctx.bus.subscribed.has(thread.id);
  // The context meter grows with every turn, the way a real session's does.
  thread.context = {
    tokens: prompt === '[compact]' && !record.cancelled ? compactAfter : (thread.context?.tokens ?? FAKE_CONTEXT_FLOOR) + FAKE_CONTEXT_PER_TURN + modelPrompt.length * 4,
    window: FAKE_CONTEXT_WINDOW,
    at: ctx.now()
  };
  ctx.touch(thread);
  ctx.emit('turn.finished', structuredClone(turn));
  pushScheduler(ctx, turn, 'finished');
  if (turn.execution?.operation === 'delegation' && thread.parentThreadId) {
    const root = thread.parentThreadId;
    const text = message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim().slice(0, 4000);
    const config = delegationConfig(ctx, root);
    if (!record.cancelled && config.enabled && !config.paused) {
      const letter: AgentLetter = {
        id: `letter-${++ctx.seq}`,
        origin: 'result',
        from: { coreId: 'local', threadId: thread.id, title: thread.title, machine: 'Boite', resources: '', status: thread.status, mode: 'team' },
        to: { coreId: 'local', threadId: root },
        toTitle: ctx.thread(root).title,
        text,
        replyTo: null,
        createdAt: ctx.now(),
        expiresAt: Number.MAX_SAFE_INTEGER,
        status: 'received',
        error: null
      };
      ctx.delegationLetters.set(root, [...(ctx.delegationLetters.get(root) ?? []), letter]);
    }
    pumpDelegation(ctx, root);
    ctx.emit('delegation.changed', { threadId: root });
  }
}

function pushScheduler(ctx: FakeContext, turn: Turn, phase: 'running' | 'finished'): void {
  if (phase === 'running') {
    ctx.scheduler.running = [
      ...ctx.scheduler.running,
      { turnId: turn.id, threadId: turn.threadId, startedAt: turn.startedAt ?? ctx.now() }
    ];
  } else {
    ctx.scheduler.running = ctx.scheduler.running.filter((r) => r.turnId !== turn.id);
  }
  ctx.emit('scheduler.updated', structuredClone(ctx.scheduler));
}
