import { ATTACHMENTS_PER_TURN, ATTACHMENTS_TOTAL_MAX_BYTES, PREVIEW_REFERENCES_PER_TURN, type Attachment, type Message, type MessageId, type PreviewReference } from '@boite/contracts';
import { isActivityCommand } from './activity-command';
import { attachedBytes } from './attachments';
import { promptText } from './message-display';
import type { Store } from './store.svelte';

/** One input's state in the store: its text, attachments and the prompts queued behind a running turn. */
export type ComposerState = NonNullable<Store['composerStates'][string]>;

/**
 * Sends consecutive ordinary prompts together, within turn limits. Activity
 * commands are submitted individually. New arrivals wait for
 * the following turn. A refusal restores the original entries and pauses them.
 */
export async function drainQueue(store: Store, threadId: string, state: ComposerState, turnId?: string): Promise<void> {
  if (state.sending || state.queued.length === 0) return;
  if (state.queued[0]!.request) { await deliverQueued(store, threadId, state); return; }
  let count = 1;
  let files = state.queued[0]!.attachments.length;
  let bytes = attachedBytes(state.queued[0]!.attachments);
  let references = state.queued[0]!.previewReferences?.length ?? 0;
  if (!isActivityCommand(state.queued[0]!.text)) {
    for (; count < state.queued.length; count++) {
      const next = state.queued[count]!;
      const weight = attachedBytes(next.attachments);
      const refs = next.previewReferences?.length ?? 0;
      if (next.request || isActivityCommand(next.text) || files + next.attachments.length > ATTACHMENTS_PER_TURN || bytes + weight > ATTACHMENTS_TOTAL_MAX_BYTES || references + refs > PREVIEW_REFERENCES_PER_TURN) break;
      files += next.attachments.length;
      bytes += weight;
      references += refs;
    }
  }
  const entries = state.queued.splice(0, count);
  let text = '';
  const attachments: Attachment[] = [];
  const previewReferences: PreviewReference[] = [];
  const referenceIds = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (index > 0) text += '\n\n';
    const offset = text.length;
    text += entry.text;
    attachments.push(...entry.attachments);
    for (const reference of entry.previewReferences ?? []) {
      let id = reference.id;
      let suffix = 0;
      while (referenceIds.has(id)) id = `${reference.id.slice(0, 60)}-queue-${++suffix}`;
      referenceIds.add(id);
      previewReferences.push({ ...reference, id,
        ...(reference.mention ? { mention: { start: reference.mention.start + offset, end: reference.mention.end + offset } } : {})
      });
    }
  }
  state.sending = true;
  let accepted: boolean | null = null;
  try {
    accepted = turnId ? await store.steer(text, threadId, turnId, attachments, previewReferences)
      : await store.send(text, threadId, attachments, previewReferences) || null;
  } finally {
    if (!accepted) {
      state.queued.unshift(...entries);
      // A lone refused prompt returns to the empty input. A batch keeps its
      // separate entries in the queue so they remain editable.
      state.paused = accepted === null;
      if (accepted === null && state.queued.length === 1 && state.text.length === 0 && state.attachments.length === 0 && !state.previewReferences?.length) {
        const back = state.queued.shift()!;
        state.text = back.text;
        state.attachments = back.attachments;
        state.previewReferences = back.previewReferences ?? [];
      }
    }
    state.sending = false;
  }
}

/**
 * The outbox prompt at the head of the queue, alone and under its own request
 * id: taken, it leaves the queue; refused, it stays with the core's reason and
 * holds the rest; otherwise it waits for the machine or the running turn.
 */
async function deliverQueued(store: Store, threadId: string, state: ComposerState): Promise<void> {
  const entry = state.queued[0]!;
  const request = entry.request!;
  state.sending = true;
  try {
    const outcome = await store.deliverQueued(threadId, { ...entry, request });
    const at = state.queued.indexOf(entry);
    if (at < 0) return;
    if (outcome === 'sent') state.queued.splice(at, 1);
    else if (outcome !== 'wait') entry.request = { ...request, failed: outcome.failed };
  } finally {
    state.sending = false;
  }
}

/** What a sent prompt held, as the composer takes it back: its words, its pictures and files, its page references. */
export interface SentPrompt {
  id: MessageId;
  text: string;
  attachments: Attachment[];
  previewReferences: PreviewReference[];
}

/** One user message as the composer would have sent it. */
export function sentPrompt(message: Message): SentPrompt {
  const attachments: Attachment[] = [];
  for (const part of message.parts) {
    if (part.type === 'image') attachments.push({ kind: 'image', mimeType: part.mimeType, data: part.data, name: part.alt });
    else if (part.type === 'file') attachments.push({ kind: 'file', mimeType: part.mimeType, data: part.data, name: part.name });
  }
  return {
    id: message.id,
    text: message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? promptText(part) : ''))
      .join('\n'),
    attachments,
    previewReferences: message.parts.flatMap(part => part.type === 'text' ? part.previewReferences ?? [] : [])
  };
}

/** A thread's own sent prompts, most recent first: what ArrowUp walks. */
export function sentPrompts(messages: Message[]): SentPrompt[] {
  return messages
    .filter((message) => message.role === 'user')
    .map(sentPrompt)
    .filter((prompt) => prompt.text.length > 0 || prompt.previewReferences.length > 0)
    .reverse();
}

/** Words or files typed in a thread's box and not sent yet: what its row marks as a draft. */
export function hasUnsentDraft(state: ComposerState | undefined): boolean {
  return state !== undefined && (state.text.trim().length > 0 || state.attachments.length > 0);
}
