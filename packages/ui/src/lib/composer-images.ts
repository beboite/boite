import type { Attachment } from '@boite/contracts';
import type { Store } from './store.svelte';
import type { ComposerState } from './composer-queue';
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

/** Insert only after the file was accepted, into the draft that received it. */
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
  }
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
