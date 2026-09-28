import type { Attachment, Message, MessageId, PreviewReference } from '@boite/contracts';
import { promptText } from './message-display';
import type { Store } from './store.svelte';

/** One input's state in the store: its text, attachments and the prompts queued behind a running turn. */
export type ComposerState = NonNullable<Store['composerStates'][string]>;

/**
 * Sends the next queued prompt of a thread; a refusal pauses the queue. The
 * prompt leaves the queue while it is on the wire: a turn the core was already
 * running puts it back at the head, to go out once that turn is over.
 */
export async function drainQueue(store: Store, threadId: string, state: ComposerState): Promise<void> {
  const entry = state.queued.shift();
  if (entry === undefined) return;
  state.sending = true;
  const accepted = await store.send(entry.text, threadId, entry.attachments, entry.previewReferences ?? []);
  if (!accepted) {
    state.queued.unshift(entry);
    // Pause after a refusal. The prompt goes back in the box for an explicit
    // retry only when it is the whole queue: taking it out from under the
    // ones behind it would send them in the order they were not typed in.
    state.paused = true;
    if (state.queued.length === 1 && state.text.length === 0 && state.attachments.length === 0 && !state.previewReferences?.length) {
      const back = state.queued.shift()!;
      state.text = back.text;
      state.attachments = back.attachments;
      state.previewReferences = back.previewReferences ?? [];
    }
  }
  state.sending = false;
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
