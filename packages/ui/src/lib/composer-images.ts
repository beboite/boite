import type { Attachment, PreviewReference } from '@boite/contracts';
import type { Store } from './store.svelte';
import type { ComposerState } from './composer-queue';
import { tileKey } from './draft-attachments';
import { editPreviewMentions } from './preview-mentions';
import { fill, strings } from './strings';

const pendingImageSends = new WeakMap<ComposerState, { text: string; inserted: boolean; edited: boolean }>();

/** Automatic image tokens must not keep already-sent prose in the next draft. */
export function trackImageSend(state: ComposerState, prompt: string, sentImages: Attachment[]) {
  const pending = { text: prompt, inserted: false, edited: false };
  pendingImageSends.set(state, pending);
  return (accepted: boolean) => {
    if (pendingImageSends.get(state) !== pending) return;
    pendingImageSends.delete(state);
    if (!accepted || !pending.inserted || pending.edited || state.text !== pending.text) return;
    state.attachments = state.attachments.filter(attachment => !sentImages.includes(attachment));
    state.text = state.attachments.filter(attachment => attachment.kind === 'image').map((_, index) => imageLabel(index + 1)).join(' ') + ' ';
    state.selection = { start: state.text.length, end: state.text.length };
    state.mentionInsertion = (state.mentionInsertion ?? 0) + 1;
  };
}

export function imageLabel(number: number): string {
  return fill(strings.composer.imageReference, { number: String(number) });
}

export function imageTextParts(text: string, attachments: Attachment[]) {
  const images = attachments.filter(attachment => attachment.kind === 'image');
  const parts: { text: string; attachment?: Attachment }[] = [];
  let at = 0;
  for (const match of text.matchAll(/\[Image ([1-9]\d*)\]/g)) {
    const attachment = images[Number(match[1]) - 1];
    if (!attachment) continue;
    if (match.index > at) parts.push({ text: text.slice(at, match.index) });
    parts.push({ text: match[0], attachment });
    at = match.index + match[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

/** At the caret of the draft that took the picture, as it is taken: its tile loads while the typing goes on. */
export function insertImageReference(store: Store, key: string) {
  const state = store.composerStates[key];
  if (!state) return;
  const start = Math.min(state.text.length, state.selection?.start ?? state.text.length);
  const end = Math.max(start, Math.min(state.text.length, state.selection?.end ?? start));
  const prefix = start && !/\s/.test(state.text[start - 1]!) ? ' ' : '';
  const inserted = prefix + imageLabel(state.attachments.filter(item => item.kind === 'image').length) + ' ';
  const pending = pendingImageSends.get(state);
  if (pending && pending.text !== state.text) pending.edited = true;
  store.editComposerText(key, state.text.slice(0, start) + inserted + state.text.slice(end), false, { start, end });
  if (pending) { pending.text = state.text; pending.inserted = true; }
  state.selection = { start: start + inserted.length, end: start + inserted.length };
  state.mentionInsertion = (state.mentionInsertion ?? 0) + 1;
}

/** Keep the remaining references aligned with the order sent to the provider. */
export function removeImageReferences(store: Store, key: string, at: number) {
  const state = store.composerStates[key];
  if (!state || state.attachments[at]?.kind !== 'image') return;
  const number = state.attachments.slice(0, at + 1).filter(item => item.kind === 'image').length;
  const count = state.attachments.filter(item => item.kind === 'image').length;
  // Separate edits retain the ranges of browser references between image tokens.
  for (const match of [...state.text.matchAll(/\[Image ([1-9]\d*)\]/g)].reverse()) {
    const index = Number(match[1]);
    if (index < number || index > count) continue;
    const end = match.index + match[0].length;
    const replacement = index === number ? '' : imageLabel(index - 1);
    store.editComposerText(key, state.text.slice(0, match.index) + replacement + state.text.slice(end), false, { start: match.index, end });
    // The caret keeps its place in the words around it, while the user may still be typing.
    const shift = (at: number) => at >= end ? at + replacement.length - (end - match.index) : Math.min(at, match.index + replacement.length);
    if (state.selection) state.selection = { start: shift(state.selection.start), end: shift(state.selection.end) };
  }
  if (state.selection) state.mentionInsertion = (state.mentionInsertion ?? 0) + 1;
}

/**
 * What a Send waiting on a file read was pressed on: its words without their
 * `[Image N]`, and each file as the tile it showed. A file that lands keeps
 * its tile, even a picture that went as a file and took its reference with
 * it; a sync that swaps the box brings other words or other files.
 */
export interface SendShape { words: string; tiles: Attachment[] }

export function sendShape(text: string, attachments: Attachment[]): SendShape {
  return { words: text.replace(/\[Image [1-9]\d*\]/g, ''), tiles: attachments.map(tileKey) };
}

export function sameSend(pressed: SendShape, now: SendShape): boolean {
  return pressed.words === now.words && pressed.tiles.length === now.tiles.length && pressed.tiles.every((tile, at) => tile === now.tiles[at]);
}

/** A box nobody types in: a step of the undo history, or a draft set aside. */
export interface QuietBox {
  text: string;
  attachments: Attachment[];
  previewReferences?: PreviewReference[];
  selection?: { start: number; end: number };
}

/**
 * A file still being read settled while `box` held its placeholder: `ready`
 * takes its place, or nothing does. A picture that did not stay one leaves
 * the text the way `removeImageReferences` leaves the live box, its
 * reference gone, those above it renumbered, mentions and caret on their
 * words. The index it was at, or -1 when `box` never held it.
 */
export function settleIn(box: QuietBox, placeholder: Attachment, ready: Attachment | null): number {
  const at = box.attachments.indexOf(placeholder);
  if (at < 0) return -1;
  if (placeholder.kind === 'image' && ready?.kind !== 'image') {
    const images = box.attachments.filter(item => item.kind === 'image');
    const number = images.indexOf(placeholder) + 1;
    for (const match of [...box.text.matchAll(/\[Image ([1-9]\d*)\]/g)].reverse()) {
      const index = Number(match[1]);
      if (index < number || index > images.length) continue;
      const start = match.index, end = start + match[0].length;
      const replacement = index === number ? '' : imageLabel(index - 1);
      const text = box.text.slice(0, start) + replacement + box.text.slice(end);
      if (box.previewReferences) box.previewReferences = editPreviewMentions(box.text, text, box.previewReferences, { start, end });
      const shift = (at: number) => at >= end ? at + replacement.length - (end - start) : Math.min(at, start + replacement.length);
      if (box.selection) box.selection = { start: shift(box.selection.start), end: shift(box.selection.end) };
      box.text = text;
    }
  }
  box.attachments = ready ? box.attachments.map((item, index) => index === at ? ready : item) : box.attachments.filter((_, index) => index !== at);
  return at;
}

/** True when `edit` (a range of `text`) reaches into an image reference: removing it is a step of its own. */
export function touchesImageReference(text: string, attachments: Attachment[], edit: { start: number; end: number } | undefined): boolean {
  if (!edit) return false;
  let at = 0;
  for (const part of imageTextParts(text, attachments)) {
    const from = at;
    at += part.text.length;
    if (!part.attachment) continue;
    // A range overlaps it; a caret only counts strictly inside it, not at its edge.
    if (edit.end > edit.start ? from < edit.end && at > edit.start : from < edit.start && edit.start < at) return true;
  }
  return false;
}

/**
 * A reference is one object in the box: an edit that cuts into it takes it
 * whole, and its image with it once no other reference names that image.
 * `edit` is the range of the old text the edit replaced. True when it did so.
 */
export function editAcrossImageReferences(store: Store, key: string, value: string, edit: { start: number; end: number } | undefined): boolean {
  const state = store.composerStates[key];
  if (!state || !edit || edit.end <= edit.start) return false;
  const old = state.text;
  const count = state.attachments.filter(item => item.kind === 'image').length;
  const cut = [...old.matchAll(/\[Image ([1-9]\d*)\]/g)].filter(match =>
    Number(match[1]) <= count && match.index < edit.end && match.index + match[0].length > edit.start);
  if (cut.length === 0) return false;
  const start = Math.min(edit.start, cut[0]!.index);
  const last = cut.at(-1)!;
  const end = Math.max(edit.end, last.index + last[0].length);
  const typed = value.slice(edit.start, Math.max(edit.start, value.length - (old.length - edit.end)));
  store.editComposerText(key, old.slice(0, start) + typed + old.slice(end), false, { start, end });
  // Highest first: removing an image renumbers the references above it.
  for (const number of [...new Set(cut.map(match => Number(match[1])))].sort((a, b) => b - a)) {
    if (state.text.includes(`[Image ${number}]`)) continue;
    let seen = 0;
    const at = state.attachments.findIndex(item => item.kind === 'image' && ++seen === number);
    removeImageReferences(store, key, at);
    state.attachments = state.attachments.filter((_, index) => index !== at);
  }
  state.selection = { start: start + typed.length, end: start + typed.length };
  state.mentionInsertion = (state.mentionInsertion ?? 0) + 1;
  return true;
}

/**
 * What the box's input event writes to the draft. Cutting into `[Image 2]`
 * takes the reference and its image, not one letter: the box is rewritten and
 * the caret it should show comes back. Null when the edit went in as typed.
 */
export function editComposerInput(store: Store, key: string, box: HTMLTextAreaElement, undo: boolean, edit: { start: number; end: number } | undefined): number | null {
  if (undo || !editAcrossImageReferences(store, key, box.value, edit)) {
    store.editComposerText(key, box.value, undo, edit);
    return null;
  }
  const state = store.composerStates[key]!;
  const caret = state.selection?.end ?? state.text.length;
  box.value = state.text;
  box.setSelectionRange(caret, caret);
  return caret;
}
