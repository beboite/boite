import type { QuestionRequest } from '@boite/contracts';
import type { Store } from './store.svelte';
import { unresolvedAssetId } from './draft-attachments';
import { sendable } from './composer-attachments';
import { focusComposer } from './focus';
import { strings } from './strings';

/*
 * A question that takes a written answer is answered from the composer: one
 * box for the text, the photos and the keyboard, where the card had a second
 * field of its own. The card keeps its options; what is picked there is held
 * here, so the composer's Send can take it, and so can a card that scrolls out
 * of the timeline's window and comes back. The user can set the questions of a
 * thread aside to write an ordinary message instead.
 *
 * A question never takes a composer the user is writing in: one that arrives
 * while its thread's composer holds a draft, or was typed in within the last
 * pause, waits until that composer is empty and quiet, so Enter sends the
 * draft as the message it was meant to be. The card can still choose it.
 */
class QuestionReplies {
  picks = $state<Record<string, string[]>>({});
  ignored = $state<Record<string, true>>({});
  /** The question the dock shows, among several asked without stopping. */
  docked = $state<string | null>(null);
  /** The question a card's "Answer in writing" gave the composer. */
  chosen = $state<string | null>(null);
  /** Questions that arrived while the user wrote: the composer leaves them until it is empty and quiet. */
  waiting = $state<Record<string, true>>({});
  /** Composers typed in within their last pause, by key: each has its own, so typing in one never ends another's. */
  typing = $state<Record<string, true>>({});
  pauses = new Map<string, ReturnType<typeof setTimeout>>();
}

/** How long a composer sits untouched before a question that arrived during typing may take it. */
export const TYPING_PAUSE_MS = 1500;

/** Per machine: question ids are only unique on the core that asked. */
const replies = new WeakMap<Store, QuestionReplies>();

export function repliesOf(store: Store): QuestionReplies {
  let held = replies.get(store);
  if (!held) { held = new QuestionReplies(); replies.set(store, held); }
  return held;
}

function drafted(store: Store, threadId: string): boolean {
  const state = store.composerStates[threadId];
  return !!state && (state.text.length > 0 || state.attachments.length > 0);
}

/** A keystroke in the composer `key`: questions arriving now wait for the pause after it. */
export function noteTyping(store: Store, key: string): void {
  const held = repliesOf(store);
  held.typing[key] = true;
  clearTimeout(held.pauses.get(key));
  held.pauses.set(key, setTimeout(() => { delete held.typing[key]; held.pauses.delete(key); }, TYPING_PAUSE_MS));
}

/**
 * Called as a question reaches this device, before it joins the pending list.
 * A question already known (a repeated event) keeps its state.
 */
export function noteQuestionAsked(store: Store, question: QuestionRequest): void {
  if (!question.allowText || store.pendingQuestions.some((known) => known.id === question.id)) return;
  const held = repliesOf(store);
  if (held.typing[question.threadId] || drafted(store, question.threadId)) held.waiting[question.id] = true;
}

/** Lets a waiting question take its composer once that composer is empty and quiet, or the question is gone. */
export function releaseWaiting(store: Store): void {
  const held = repliesOf(store);
  for (const id of Object.keys(held.waiting)) {
    const question = store.pendingQuestions.find((pending) => pending.id === id);
    if (!question || (!held.typing[question.threadId] && !drafted(store, question.threadId))) delete held.waiting[id];
  }
}

/**
 * The question the composer answers, or null when it sends ordinary messages.
 * The one a card chose, else the question the agent stopped for, else the one
 * the dock shows. None while the composer edits a sent message: Send replaces
 * that message, and a card's Answer must not take the recalled text. A question
 * that arrived while the user wrote is left out until it is released.
 *
 * Only the open thread's own questions are ever the target. A sub-agent's
 * question docked in its parent is answered from its card or in its own
 * conversation: while the dock shows one, the composer falls back to no
 * other docked question either, so text typed under a child's card is an
 * ordinary message and never answers a question the user cannot see.
 */
export function replyTarget(store: Store): QuestionRequest | null {
  const thread = store.openThread?.id;
  if (!thread || store.composerStates[thread]?.editing) return null;
  const held = repliesOf(store);
  const open = store.pendingQuestions.filter((question) =>
    question.threadId === thread && question.allowText && !held.ignored[question.id] && (!held.waiting[question.id] || question.id === held.chosen));
  const dockedElsewhere = held.docked !== null && (store.pendingSecrets.some(request => request.id === held.docked)
    || store.pendingQuestions.some((question) => question.id === held.docked && question.threadId !== thread));
  return open.find((question) => question.id === held.chosen)
    ?? open.find((question) => question.async !== true)
    ?? open.find((question) => question.id === held.docked)
    ?? (dockedElsewhere ? null : open[0])
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
 * this question, both as they were when Send was pressed. Pictures still being
 * fitted go once they fit; when the composer answers another question by then,
 * or stays over the byte total, nothing goes. Only what went out leaves the
 * composer: text typed or picks changed while the answer waited, or while the
 * call was on its way, stay. False gives the card back.
 */
export async function sendAnswer(store: Store, question: QuestionRequest): Promise<boolean> {
  const held = repliesOf(store);
  const state = replyTarget(store)?.id === question.id ? store.composerStates[question.threadId] : undefined;
  const optionIds = held.picks[question.id] ?? [];
  const text = state?.text ?? '';
  if (state) {
    const ready = sendable(store, state, () => store.composerStates[question.threadId]!);
    if (!(typeof ready === 'boolean' ? ready : await ready) || replyTarget(store)?.id !== question.id) return false;
  }
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
  if ((held.picks[question.id] ?? []) === optionIds) delete held.picks[question.id];
  if (held.chosen === question.id) held.chosen = null;
  return true;
}

/** A card's "Answer in writing": the composer takes this question, and the focus. */
export function writeAnswer(store: Store, questionId: string): void {
  const held = repliesOf(store);
  delete held.ignored[questionId];
  delete held.waiting[questionId];
  held.chosen = questionId;
  focusComposer({ typing: true });
}

/** The composer's way out: the open thread's questions wait, and it sends ordinary messages. */
export function ignoreQuestions(store: Store): void {
  const held = repliesOf(store);
  for (const question of store.pendingQuestions) {
    if (question.threadId === store.openThread?.id) held.ignored[question.id] = true;
  }
  held.chosen = null;
}
