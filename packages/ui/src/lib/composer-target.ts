import type { Snippet } from 'svelte';
import type { Attachment, ProviderSummary, Thread } from '@boite/contracts';
import type { ComposerState, SentPrompt } from './composer-queue';
import { resetHistory } from './composer-history';
import type { Choice, Store } from './store.svelte';

/**
 * Where a composer sends when it belongs to no thread: an agent's
 * conversation. The box keeps everything a thread's has (attachments,
 * dictation, recall, undo, paste, drop and the stash). The model, effort and
 * mode chips draw the agent's own when it hands them over (`selection`); the
 * queue and the slash and mention menus act on a thread and stay out.
 */
export interface ComposerTarget {
  /** The key of its input in `store.composerStates`; never a thread's id. */
  key: string;
  placeholder: string;
  /** The provider the recipient answers on: it decides which pictures go as images. */
  provider: ProviderSummary | null;
  /** What ArrowUp walks, most recent first. */
  sent: SentPrompt[];
  /** The recipient is at work: Stop shows and Escape stops it. */
  busy: boolean;
  /** True once the message is accepted; the box empties then. */
  send(text: string, attachments: Attachment[]): Promise<boolean>;
  stop?: () => void;
  /** What the bar shows where a thread's chips go, after the model chips when there are some. */
  chips?: Snippet;
  /**
   * The recipient's model, effort and mode, which the thread's chips show and
   * change: a pick saves it as the recipient's own setting. None for a group,
   * nor for a device that may not change the agent.
   */
  selection?: { choice: Choice; save(next: Choice): Promise<void> };
}

/** The chips' choice: the open thread's, the remembered one on a draft, the agent's own on its box. */
export function chipChoice(store: Store, thread: Thread | null, target: ComposerTarget | null): Choice | null {
  if (target) return target.selection?.choice ?? null;
  if (thread) return store.composerChoice({ providerId: thread.providerId, accountId: thread.accountId, permissionMode: thread.permissionMode, model: thread.model, effort: thread.effort, speed: thread.speed ?? null });
  return store.draft ? store.defaultChoice() : null;
}

/** An agent's message: no queue and no rewind. The box empties once the core took it; true then. */
export async function sendToTarget(target: ComposerTarget, state: ComposerState, prompt: string, attachments: Attachment[]): Promise<boolean> {
  state.sending = true;
  try {
    const sent = await target.send(prompt, attachments);
    if (sent) {
      if (state.text === prompt) state.text = '';
      if (state.attachments === attachments) state.attachments = [];
      if (state.text === '') resetHistory(state);
    }
    return sent;
  } finally {
    state.sending = false;
  }
}
