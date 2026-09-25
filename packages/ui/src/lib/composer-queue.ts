import type { Message, PreviewReference } from '@boite/contracts';
import { promptText } from './message-display';
import type { Store } from './store.svelte';

/** One input's state in the store: its text, attachments and the prompts queued behind a running turn. */
export type ComposerState = NonNullable<Store['composerStates'][string]>;

/** Sends the next queued prompt of a thread; a refusal pauses the queue. */
export async function drainQueue(store: Store, threadId: string, state: ComposerState): Promise<void> {
  const entry = state.queued[0];
  if (entry === undefined) return;
  state.sending = true;
  const accepted = await store.send(entry.text, threadId, entry.attachments, entry.previewReferences ?? []);
  if (accepted) state.queued.shift();
  else {
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

/** A thread's own sent prompts, most recent first: what ArrowUp walks. */
export function sentPrompts(messages: Message[]): { text: string; previewReferences: PreviewReference[] }[] {
  return messages
    .filter((message) => message.role === 'user')
    .map((message) => ({ text: message.parts
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? promptText(part) : ''))
        .join('\n'), previewReferences: message.parts.flatMap(part => part.type === 'text' ? part.previewReferences ?? [] : [])
    }))
    .filter((prompt) => prompt.text.length > 0 || prompt.previewReferences.length > 0)
    .reverse();
}
