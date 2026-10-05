import type { Attachment, Message, PreviewReference } from '@boite/contracts';
import { emptyBox, returnPrompt, sentPrompt, type ComposerState } from './composer-queue';
import type { Store } from './store.svelte';
import { strings } from './strings';

/**
 * An edit goes on screen at once: the box empties, the edited message and what
 * follows it hide, and the replacement shows while the core rewinds the thread
 * and restores files. `local` is that replacement's row, for the send that
 * follows. A refusal brings the messages back and returns the text to the box,
 * still in edit mode, without queuing a duplicate: false.
 */
export async function rewindComposerEdit(
  store: Store, key: string, state: ComposerState, prompt: string, attachments: Attachment[], previewReferences: PreviewReference[]
): Promise<false | { local: Message | null }> {
  const editing = state.editing;
  if (!editing) return { local: null };
  if (state.queued.length) { store.error = strings.composer.editingQueued; return false; }
  const local = store.stageSend(key, prompt, attachments, previewReferences);
  emptyBox(state);
  state.editing = null;
  state.sending = true;
  try {
    if (await store.rewind(editing, key)) return { local };
    if (local) store.unstageSend(local);
    returnPrompt(state, prompt, attachments, previewReferences);
    // Back in the box it is still an edit; behind text typed since, it waits in the queue as a plain prompt.
    if (state.text === prompt && state.attachments === attachments) state.editing = editing;
    return false;
  } finally {
    state.sending = false;
  }
}

/**
 * The last turn again from its own prompt: the answer leaves the screen and
 * the prompt shows as sent at once, then the core rewinds and the prompt goes
 * out. A send that fails after the rewind leaves the prompt in the box.
 */
export async function retryTurn(store: Store, threadId: string, prompt: Message): Promise<void> {
  const again = sentPrompt(prompt);
  const local = store.stageSend(threadId, again.text, again.attachments, again.previewReferences);
  const rewound = await store.rewind(prompt.id, threadId);
  const sent = rewound ? await store.send(rewound.prompt, threadId, rewound.attachments, rewound.previewReferences) : false;
  if (sent) return;
  if (local) store.unstageSend(local);
  if (rewound) store.restoreDraft(threadId, rewound.prompt, rewound.attachments, rewound.previewReferences);
}
