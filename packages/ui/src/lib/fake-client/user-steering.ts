import { attachmentError, previewPrompt, previewReferencesError, protocolSupportsSteering, type MessagePart, type Message, type RpcParams } from '@boite/contracts';
import type { FakeContext } from './context';
import { refusal } from './shared';

/** The fixture accepts live user messages without opening or stopping a turn. */
export async function steerUser(ctx: FakeContext, params: RpcParams<'turns.steer'>): Promise<{ accepted: boolean }> {
  const thread = ctx.thread(params.threadId);
  if (thread.archived || thread.agentSessionId) throw refusal('user steering requires an active, unarchived conversation');
  if (typeof params.prompt !== 'string') throw refusal('prompt must be a string');
  if (typeof params.clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(params.clientRequestId)) throw refusal('clientRequestId must contain 8 to 128 URL-safe characters');
  const attachments = params.attachments ?? [];
  const references = params.previewReferences ?? [];
  if (!Array.isArray(attachments) || attachments.some(attachment => !attachment || typeof attachment !== 'object')) throw refusal('attachments must be an array of attachment objects');
  const referenceError = previewReferencesError(references, params.prompt);
  if (referenceError) throw refusal(referenceError);
  const provider = ctx.providers.find(provider => provider.id === thread.providerId);
  if (!provider) throw ctx.notFound('provider', thread.providerId);
  const error = attachmentError(attachments, provider);
  if (error) throw refusal(error.message);
  const content = 'steer:' + JSON.stringify([params.turnId, params.prompt, attachments, references]);
  const key = `${params.threadId}:${params.clientRequestId}`;
  const previous = ctx.turnRequests.get(key);
  if (previous) {
    if (previous.content !== content) throw refusal('clientRequestId was already used for different content');
    return { accepted: true };
  }
  if (params.expectedSelectionVersion !== undefined && params.expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw refusal('the model selection changed; review the selected model and send again');
  const turn = thread.turns.find(turn => turn.id === params.turnId);
  const running = ctx.inFlight.get(thread.id);
  if (thread.status !== 'running' || !turn || turn.status !== 'running' || turn.execution?.operation === 'compact' || !running || running.cancelled || !protocolSupportsSteering(provider.protocol)) return { accepted: false };
  if ((turn.execution?.selectionVersion ?? 0) !== (thread.selectionVersion ?? 0)) return { accepted: false };
  if ([...ctx.pendingPermissions.values()].some(item => item.request.threadId === thread.id) || [...ctx.pendingQuestions.values()].some(item => item.request.threadId === thread.id && !item.request.async)) return { accepted: false };
  const message: Message = { id: `m-${++ctx.seq}`, threadId: thread.id, turnId: turn.id, role: 'user', state: 'complete', createdAt: ctx.now(), parts: [
    { type: 'text', text: previewPrompt(params.prompt, references), ...(references.length ? { displayText: params.prompt, previewReferences: JSON.parse(JSON.stringify(references)) } : {}) },
    ...attachments.map((attachment): MessagePart => attachment.kind === 'file'
      ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name }
      : { type: 'image', mimeType: attachment.mimeType, data: attachment.data, alt: attachment.name }),
  ] };
  thread.messages.push(message);
  (running.steered ??= []).push({ prompt: previewPrompt(params.prompt, references), attachments });
  ctx.turnRequests.set(key, { content, turn, messageId: message.id });
  ctx.emitToThread(thread.id, 'message.started', structuredClone(message));
  ctx.emitToThread(thread.id, 'message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
  thread.lastUserMessageAt = message.createdAt;
  ctx.touch(thread);
  return { accepted: true };
}
