import { type Attachment, type Message, type MessageId, type PreviewReference } from '@boite/contracts';
import { readExperiments } from './experiments';
import { promptText } from './message-display';
import { secureId } from './secure-id';
import type { Store } from './store.svelte';

/** One input's state in the store: its text, attachments and the prompts queued behind a running turn. */
export type ComposerState = NonNullable<Store['composerStates'][string]>;

/** The id of a prompt drawn before the core has it; its turn id starts the same way until `turns.start` answers. */
export const SENDING_PREFIX = 'local:';

/** A prompt on its way to the core: it has no turn yet and cannot be edited, forked or retried. */
export function isSending(message: Pick<Message, 'id'>): boolean {
  return message.id.startsWith(SENDING_PREFIX);
}

/** The box gives up what just left it: its words, its files and its page references. */
export function emptyBox(state: ComposerState): void {
  state.text = '';
  state.attachments = [];
  state.previewReferences = [];
  state.paused = false;
}

/**
 * A prompt the core refused, or whose send was lost, back where it can be sent
 * again. An empty box takes it. A box already holding the next prompt keeps
 * that one, and this one waits, held, at the head of the queue.
 */
export function returnPrompt(state: ComposerState, text: string, attachments: Attachment[], previewReferences: PreviewReference[]): void {
  if (state.text.length === 0 && state.attachments.length === 0 && !state.previewReferences?.length) {
    state.text = text;
    state.attachments = attachments;
    state.previewReferences = previewReferences;
    return;
  }
  // Its own id and experiments from the start, as `queuePrompt` gives: a put already on its way cannot then merge it away.
  state.queued.unshift({ id: secureId(), text, attachments, experiments: readExperiments(), ...(previewReferences.length ? { previewReferences } : {}) });
  state.paused = true;
}

/**
 * Turns texts into queue entries that keep their identity while their text
 * does. The bubbles are keyed by entry: a fresh object on every thread update
 * would remount them and replay their arrival animation.
 */
export function textEntries(): (texts: readonly string[]) => { text: string; attachments: Attachment[] }[] {
  let previous: { text: string; attachments: Attachment[] }[] = [];
  return (texts) => (previous = texts.map((text, at) => previous[at]?.text === text ? previous[at]! : { text, attachments: [] }));
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
