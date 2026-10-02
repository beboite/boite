import { createHash } from 'node:crypto';
import { previewPrompt, previewReferencesError, type Message, type MessagePart, type RpcParams } from '@boite/contracts';
import type { Core } from '../core.ts';
import { prepareAttachments } from '../attachments.ts';
import { messageOf, refused } from '../errors.ts';
import { newId } from '../ids.ts';
import type { ThreadStore } from '../threads.ts';
import { checkAttachmentArray, checkAttachments } from './inputs.ts';
import { saveThread } from './records.ts';

/** User input keeps its own provenance and receipt while sharing the active provider turn. */
export async function steerUser(core: Core, threads: ThreadStore, params: RpcParams<'turns.steer'>): Promise<{ accepted: boolean }> {
  const { threadId, turnId, prompt, clientRequestId, expectedSelectionVersion } = params;
  const thread = threads.require(threadId);
  if (core.stopping || thread.archived || thread.agentSessionId) throw refused('user steering requires an active, unarchived conversation');
  if (typeof prompt !== 'string') throw refused('prompt must be a string', { field: 'prompt', expected: 'a string' });
  if (typeof clientRequestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(clientRequestId)) throw refused('clientRequestId must contain 8 to 128 URL-safe characters');
  const attachments = params.attachments ?? [];
  const references = params.previewReferences ?? [];
  checkAttachmentArray(attachments);
  const referenceError = previewReferencesError(references, prompt);
  if (referenceError) throw refused(referenceError);
  checkAttachments(attachments, core.providers.require(thread.providerId));
  const fingerprint = createHash('sha256').update(JSON.stringify([turnId, prompt, attachments, references])).digest('hex');
  const previous = core.journal.turnRequest(threadId, clientRequestId);
  if (previous) {
    if (!previous.fingerprint.endsWith(`:${fingerprint}`)) throw refused('clientRequestId was already used for different content');
    if (previous.fingerprint === `steer:accepted:${fingerprint}`) return { accepted: true };
    throw refused('delivery of this message is unconfirmed; it will not be submitted again automatically', { reason: 'delivery-uncertain', threadId });
  }
  if (expectedSelectionVersion !== undefined && expectedSelectionVersion !== (thread.selectionVersion ?? 0)) throw refused('the model selection changed; review the selected model and send again');
  const turn = core.journal.getTurn(turnId);
  const runner = threads.runner;
  const handle = runner.handles.get(threadId);
  const submit = handle?.steerUser?.bind(handle) ?? handle?.steer?.bind(handle);
  if (thread.status !== 'running' || !turn || turn.threadId !== threadId || turn.status !== 'running' || turn.execution?.operation === 'compact' || !submit || runner.steering.has(threadId)) return { accepted: false };
  // Picker changes apply to the next turn, never to input for the old execution.
  if ((turn.execution?.selectionVersion ?? 0) !== (thread.selectionVersion ?? 0)) return { accepted: false };
  if (threads.listPermissions(threadId).length || threads.listQuestions(threadId).some(question => !question.async)) return { accepted: false };
  const prepared = prepareAttachments(core.dataDir, { prompt: previewPrompt(prompt, references), attachments });
  const message: Message = { id: newId('msg_'), threadId, turnId, role: 'user', state: 'complete', createdAt: Date.now(), parts: [
    { type: 'text', text: previewPrompt(prompt, references), ...(references.length ? { displayText: prompt, previewReferences: structuredClone(references) } : {}) },
    ...attachments.map((attachment): MessagePart => attachment.kind === 'file'
      ? { type: 'file', mimeType: attachment.mimeType, data: attachment.data, name: attachment.name }
      : { type: 'image', mimeType: attachment.mimeType, data: attachment.data, alt: attachment.name }),
  ] };
  runner.steering.add(threadId);
  try {
    // Reserve before crossing the native boundary. A lost acknowledgement or crash cannot cause duplicate work.
    core.journal.putTurnRequest(threadId, clientRequestId, `steer:pending:${fingerprint}`, turnId);
    if (!await submit(prepared.prompt, prepared.attachments)) {
      core.journal.db.query('DELETE FROM turn_requests WHERE thread_id = ? AND request_id = ?').run(threadId, clientRequestId);
      return { accepted: false };
    }
    core.bus.afterCommit(() => core.journal.db.transaction(() => {
      core.journal.append({ type: 'message.started', threadId, version: 1, payload: message }, () => {
        core.journal.putMessage(message);
        core.journal.db.query('UPDATE turn_requests SET fingerprint = ?, message_id = ? WHERE thread_id = ? AND request_id = ?').run(`steer:accepted:${fingerprint}`, message.id, threadId, clientRequestId);
      });
      core.bus.emit('message.started', message);
      core.bus.emit('message.completed', { threadId, messageId: message.id, state: 'complete' });
      runner.answerAfter.set(turnId, message.createdAt);
      saveThread(core, threads.require(threadId), 'thread.userInput');
    })());
    return { accepted: true };
  } catch (error) {
    throw refused(`delivery of this message is unconfirmed: ${messageOf(error)}`, { reason: 'delivery-uncertain', threadId });
  } finally {
    runner.steering.delete(threadId);
    void threads.deferred.memory.flushRunning(threadId);
  }
}
