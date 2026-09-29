import type { Attachment } from '@boite/contracts';
import type { Store } from './store.svelte';
import { fill, strings } from './strings';

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
  store.editComposerText(key, state.text.slice(0, start) + inserted + state.text.slice(end), false, { start, end });
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
