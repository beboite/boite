import type { ComposerState } from './composer-queue';
import type { Store } from './store.svelte';
import { editComposerInput } from './composer-images';
import { recordEdit, redoStep, settled, undoStep, type ComposerSnapshot } from './composer-history';
import { copiedFrom, copyImages, fitCopy, pastesAsText } from './composer-clipboard';
import { acceptAttachments } from './attachments';
import { fill, strings } from './strings';
import { touchScreen } from './device';
import { undo } from './undo.svelte';

/**
 * The composer's own edits: undo and redo from its history, and the copy, cut
 * and paste that carry `[Image N]` pictures. Composer.svelte lends each call
 * the box and the input it writes; `moved` gives it back the caret, ends a
 * recall and regrows the box.
 */
export interface EditingHost {
  store: Store;
  key: string;
  box: HTMLTextAreaElement | undefined;
  state: ComposerState;
  /** Where pasted pictures go; null for an answer, whose files reach the agent as paths whatever it reads. */
  provider: { name: string; capabilities: { images: boolean } } | null;
  moved: (caret: number) => void;
  /** The key the box shows now, when it can move to another one while a toast waits. */
  shown?: () => string;
}

/** The box's own selection, or nothing before it exists. */
export function boxSelection(box: HTMLTextAreaElement | undefined): { start: number; end: number } | undefined {
  return box ? { start: box.selectionStart, end: box.selectionEnd } : undefined;
}

/**
 * Ctrl+Z and Ctrl+Y (or Ctrl+Shift+Z), and the context menu's Undo: the
 * composer's history, never the textarea's, which a written value wipes and
 * which never held the attachments (`composer-history.ts`).
 */
export function travel(host: EditingHost, back: boolean): void {
  const { state, box } = host;
  const step = back ? undoStep(state, boxSelection(box)) : redoStep(state, boxSelection(box));
  if (step) restoreStep(host, step);
}

/** Less than this gone, and no picture: a box cleared on a phone is no loss worth a toast. */
const WORTH_UNDO_CHARS = 40;
let offered: { id: number; key: string } | null = null;

/**
 * A phone has no Ctrl+Z: a draft emptied in one go, or replaced by Edit,
 * offers its way back in the undo toast for a few seconds, the step Ctrl+Z
 * would take. Typing, a file going in or the box moving to another
 * conversation closes the offer (`closeDraftUndo`), and a box whose text or
 * files changed since, or that shows another key, is left alone, so the toast
 * never takes back another step or rewrites a draft off screen.
 */
export function offerDraftUndo(host: EditingHost, before: { text: string; attachments: number }, message: string): void {
  if (!touchScreen() || (before.text.trim().length < WORTH_UNDO_CHARS && before.attachments === 0)) return;
  const { store, key, state } = host, after = state.text, files = [...state.attachments];
  const untouched = () => state.text === after && state.attachments.length === files.length && state.attachments.every((file, at) => file === files[at]);
  undo.offer(message, async () => {
    const mine = offered?.key === key;
    offered = null;
    if (mine && (host.shown?.() ?? key) === key && store.composerStates[key] === state && untouched()) travel(host, true);
  });
  offered = { id: undo.current?.id ?? 0, key };
}

/** The composer's undo offer ends with the next edit; given a key, only that key's offer ends, as its box leaves it. */
export function closeDraftUndo(key?: string): void {
  if (!offered || (key !== undefined && offered.key !== key)) return;
  if (undo.current?.id === offered.id) undo.dismiss();
  offered = null;
}

/** Text, pictures, page references and selection exactly as the step held them. */
function restoreStep({ store, key, box, state, moved }: EditingHost, step: ComposerSnapshot): void {
  state.attachments = [...step.attachments];
  state.previewReferences = [...step.previewReferences];
  state.editing = step.editing;
  // Persists the draft at once; the references it would re-derive are the step's own.
  store.editComposerText(key, step.text);
  state.previewReferences = [...step.previewReferences];
  const end = Math.min(step.text.length, step.selection.end), start = Math.min(end, step.selection.start);
  state.selection = { start, end };
  if (box) { box.value = step.text; box.setSelectionRange(start, end); }
  settled(state);
  moved(end);
}

/** The box's text after an edit the composer made itself, with the caret after `at` unless a reference took more. */
function writeEdit({ store, key, box, state, moved }: EditingHost, value: string, edit: { start: number; end: number }, at: number): void {
  if (!box) return;
  box.value = value;
  const whole = editComposerInput(store, key, box, false, edit);
  if (whole === null) { box.setSelectionRange(at, at); state.selection = { start: at, end: at }; }
  settled(state);
  moved(whole ?? at);
}

/**
 * A copy or cut that takes `[Image 2]` takes its picture too (`composer-clipboard.ts`).
 * A cut is then the composer's own edit: one undo step, the reference and its picture going together.
 */
export function copySelection(host: EditingHost, event: ClipboardEvent, cut: boolean): void {
  const { box, state } = host;
  if (!box) return;
  const start = box.selectionStart, end = box.selectionEnd;
  if (!copyImages(event.clipboardData, state, start, end)) return;
  event.preventDefault();
  if (!cut) return;
  const before = { text: state.text, attachments: state.attachments.length };
  closeDraftUndo();
  recordEdit(state, 'big', { start, end });
  writeEdit(host, state.text.slice(0, start) + state.text.slice(end), { start, end }, start);
  if (!state.text && !state.attachments.length) offerDraftUndo(host, before, strings.composer.draftCleared);
}

/**
 * Pasting a copy of ours into another composer, here or on another machine,
 * brings its pictures and renumbers their references. Where they already
 * stand under the same numbers, the browser's own paste is enough.
 */
export function pasteImages(host: EditingHost, event: ClipboardEvent): boolean {
  const { box, state, store, provider } = host;
  const copied = copiedFrom(event.clipboardData);
  if (!copied || !box || pastesAsText(copied, state)) return false;
  event.preventDefault();
  closeDraftUndo();
  const start = box.selectionStart, end = box.selectionEnd;
  const fitted = fitCopy(copied, state.attachments, (incoming) => {
    if (incoming.length === 0) return [];
    if (provider && !provider.capabilities.images) {
      store.error = fill(strings.composer.attachNoImages, { provider: provider.name });
      return [];
    }
    const result = acceptAttachments(state.attachments, incoming);
    if (result.refused !== null) store.error = result.refused;
    return incoming.filter((item) => result.accepted.includes(item));
  });
  // Every picture refused and nothing left to write: the selection stays, the refusal is on screen.
  if (!fitted.text && fitted.attachments.length === state.attachments.length) return true;
  recordEdit(state, 'big', { start, end });
  state.attachments = fitted.attachments;
  writeEdit(host, state.text.slice(0, start) + fitted.text + state.text.slice(end), { start, end }, start + fitted.text.length);
  return true;
}
