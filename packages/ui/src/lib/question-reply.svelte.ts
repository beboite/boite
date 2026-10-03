import type { QuestionRequest } from '@boite/contracts';
import type { Store } from './store.svelte';
import { unresolvedAssetId } from './draft-attachments';
import { focusComposer } from './focus';
import { strings } from './strings';

/*
 * A question that takes a written answer is answered from the composer: one
 * box for the text, the photos and the keyboard, where the card had a second
 * field of its own. The card keeps its options; what is picked there is held
 * here, so the composer's Send can take it, and so can a card that scrolls out
 * of the timeline's window and comes back. The user can set the questions of a
 * thread aside to write an ordinary message instead.
 */
class QuestionReplies {
  picks = $state<Record<string, string[]>>({});
  ignored = $state<Record<string, true>>({});
  /** The question the dock shows, among several asked without stopping. */
  docked = $state<string | null>(null);
  /** The question a card's "Answer in writing" gave the composer. */
  chosen = $state<string | null>(null);
}

/** Per machine: question ids are only unique on the core that asked. */
const replies = new WeakMap<Store, QuestionReplies>();

export function repliesOf(store: Store): QuestionReplies {
  let held = replies.get(store);
  if (!held) { held = new QuestionReplies(); replies.set(store, held); }
  return held;
}

/**
 * The question the composer answers, or null when it sends ordinary messages.
 * The one a card chose, else the question the agent stopped for, else the one
 * the dock shows.
 */
export function replyTarget(store: Store): QuestionRequest | null {
  const thread = store.openThread?.id;
  if (!thread) return null;
  const held = repliesOf(store);
  const open = store.pendingQuestions.filter((question) => question.threadId === thread && question.allowText && !held.ignored[question.id]);
  return open.find((question) => question.id === held.chosen)
    ?? open.find((question) => question.async !== true)
    ?? open.find((question) => question.id === held.docked)
    ?? open[0]
    ?? null;
}

/** What a card shows of the composer: whether it answers this question, and holds anything for it. */
export function replyOf(store: Store, questionId: string): { replying: boolean; drafted: boolean } {
  const target = replyTarget(store);
  if (target?.id !== questionId) return { replying: false, drafted: false };
  const state = store.composerStates[target.threadId];
  return { replying: true, drafted: !!state && (state.text.trim().length > 0 || state.attachments.length > 0) };
}

/**
 * Sends the card's picks with what the composer holds when the composer answers
 * this question. Only what went out leaves the composer: text typed while the
 * call was on its way stays. False gives the card back.
 */
export async function sendAnswer(store: Store, question: QuestionRequest): Promise<boolean> {
  const held = repliesOf(store);
  const optionIds = held.picks[question.id] ?? [];
  const state = replyTarget(store)?.id === question.id ? store.composerStates[question.threadId] : undefined;
  const text = state?.text ?? '';
  const attachments = state?.attachments ?? [];
  if (attachments.some(unresolvedAssetId)) { store.error = strings.errors.draftAttachment; return false; }
  if (state) state.sending = true;
  try {
    if (!await store.answerQuestion(question.threadId, question.id, optionIds, text.trim(), attachments)) return false;
  } finally {
    if (state) state.sending = false;
  }
  if (state?.text === text) state.text = '';
  if (state?.attachments === attachments) state.attachments = [];
  delete held.picks[question.id];
  if (held.chosen === question.id) held.chosen = null;
  return true;
}

/** A card's "Answer in writing": the composer takes this question, and the focus. */
export function writeAnswer(store: Store, questionId: string): void {
  const held = repliesOf(store);
  delete held.ignored[questionId];
  held.chosen = questionId;
  focusComposer();
}

/** The composer's way out: the open thread's questions wait, and it sends ordinary messages. */
export function ignoreQuestions(store: Store): void {
  const held = repliesOf(store);
  for (const question of store.pendingQuestions) {
    if (question.threadId === store.openThread?.id) held.ignored[question.id] = true;
  }
  held.chosen = null;
}
