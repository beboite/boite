import type { Attachment, PreviewReference } from '@boite/contracts';
import type { ComposerState } from './composer-queue';

/**
 * The composer's own undo. The textarea's native stack dies on every value the
 * app writes (a recalled prompt, a slash pick, an image reference cut whole)
 * and never held the attachments, so a Ctrl+A, Backspace and one stray key
 * used to lose a prompt for good. Each composer state keeps its own steps here,
 * the draft's included, and they follow the state object when the draft
 * becomes a thread. A step is the state before an edit: text, the same
 * Attachment objects, page references, selection and the sent message the box
 * was editing, so undoing an Edit gives back a plain draft, not an edit of it.
 */
export interface ComposerSnapshot {
  text: string;
  attachments: Attachment[];
  previewReferences: PreviewReference[];
  selection: { start: number; end: number };
  editing: string | null;
}

/** Typing that grows one step, or an edit that is a step on its own. */
export type EditKind = 'insert' | 'delete' | 'big';

interface History {
  undo: ComposerSnapshot[];
  redo: ComposerSnapshot[];
  /** The kind of the step typing would extend, null once something closed it. */
  open: EditKind | null;
  /** When that step last grew. */
  at: number;
  /** The text the last recorded edit left: anything else means a write we did not see. */
  after: string | null;
  /** A big step was taken in this task: the rest of the same operation belongs to it. */
  sealed: boolean;
}

export const HISTORY_LIMIT = 200;
/** A pause this long in typing starts a new step. */
export const HISTORY_PAUSE_MS = 1000;

const histories = new WeakMap<ComposerState, History>();

function historyOf(state: ComposerState): History {
  let history = histories.get(state);
  if (!history) {
    history = { undo: [], redo: [], open: null, at: 0, after: null, sealed: false };
    histories.set(state, history);
  }
  return history;
}

export function snapshotOf(state: ComposerState, selection?: { start: number; end: number }): ComposerSnapshot {
  const at = selection ?? state.selection ?? { start: state.text.length, end: state.text.length };
  return {
    text: state.text,
    attachments: [...state.attachments],
    previewReferences: [...(state.previewReferences ?? [])],
    selection: { start: at.start, end: at.end },
    editing: state.editing ?? null
  };
}

function same(a: ComposerSnapshot, b: ComposerSnapshot): boolean {
  return a.text === b.text && a.editing === b.editing &&
    a.attachments.length === b.attachments.length && a.attachments.every((item, index) => item === b.attachments[index]) &&
    a.previewReferences.length === b.previewReferences.length && a.previewReferences.every((item, index) => item === b.previewReferences[index]);
}

function push(history: History, snapshot: ComposerSnapshot): void {
  const top = history.undo.at(-1);
  if (!top || !same(top, snapshot)) {
    history.undo.push(snapshot);
    if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  }
}

/**
 * What an input event does to the history. A selection replaced or deleted,
 * a paste, a cut, a drop, a word or line deleted at once is a step of its own;
 * one character typed or erased extends the step of its kind.
 */
export function editKind(inputType: string | undefined, edit: { start: number; end: number } | undefined): EditKind {
  if (!inputType || !edit || edit.end - edit.start > 1) return 'big';
  if (inputType === 'insertText' || inputType === 'insertCompositionText' || inputType === 'insertLineBreak' || inputType === 'insertParagraph') return 'insert';
  if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') return 'delete';
  return 'big';
}

/**
 * Called with the state still holding the text before the edit. `kind` comes
 * from `editKind`; `typed` is what an insertion writes, for word boundaries.
 * A new step starts when the kind changes, after a pause, at a space or new
 * line typed after a word, after anything the history did not record, and
 * always for a big edit. Any new edit drops the redo steps.
 */
export function recordEdit(state: ComposerState, kind: EditKind, before: { start: number; end: number } | undefined, typed: string | null = null, now = Date.now()): void {
  const history = historyOf(state);
  if (kind === 'big' && history.sealed) return;
  history.redo = [];
  const boundary = kind === 'insert' && typed !== null && /^\s+$/.test(typed) && before !== undefined &&
    before.start > 0 && !/\s/.test(state.text[before.start - 1] ?? ' ');
  const extend = kind !== 'big' && history.open === kind && now - history.at < HISTORY_PAUSE_MS &&
    history.after === state.text && !boundary && history.undo.length > 0;
  if (!extend) push(history, snapshotOf(state, before));
  history.open = kind === 'big' ? null : kind;
  history.at = now;
  if (kind === 'big') {
    // Whatever else the same operation writes (its attachments, its references) joins this step.
    history.sealed = true;
    queueMicrotask(() => { history.sealed = false; });
  }
}

/** A write the app makes on its own (recall, stash, a pick, an image in or out): one step. */
export function checkpoint(state: ComposerState): void {
  recordEdit(state, 'big', undefined);
}

/** The text an edit left, read after it settled: typing only extends a step that starts from it. */
export function settled(state: ComposerState): void {
  historyOf(state).after = state.text;
}

/** A sent prompt is gone from the box for good: undo cannot bring it back. */
export function resetHistory(state: ComposerState): void {
  histories.delete(state);
}

function travel(state: ComposerState, from: 'undo' | 'redo', selection?: { start: number; end: number }): ComposerSnapshot | null {
  const history = historyOf(state);
  const target = history[from].pop();
  if (!target) return null;
  const current = snapshotOf(state, selection);
  (from === 'undo' ? history.redo : history.undo).push(current);
  history.open = null;
  history.after = target.text;
  return target;
}

/** The step to restore, the current state kept for redo; null with nothing to undo. */
export function undoStep(state: ComposerState, selection?: { start: number; end: number }): ComposerSnapshot | null {
  return travel(state, 'undo', selection);
}

export function redoStep(state: ComposerState, selection?: { start: number; end: number }): ComposerSnapshot | null {
  return travel(state, 'redo', selection);
}

/** How many steps each way, for tests and the context menu. */
export function historyDepth(state: ComposerState): { undo: number; redo: number } {
  const history = histories.get(state);
  return { undo: history?.undo.length ?? 0, redo: history?.redo.length ?? 0 };
}
