import type { Attachment } from '@boite/contracts';
import type { ComposerState } from './composer-queue';
import { imageLabel, imageTextParts } from './composer-images';
import { isLoading } from './draft-attachments';

/**
 * `[Image 2]` copied out of one prompt brings its picture along. The text goes
 * to the clipboard as text; the pictures stay here, in this page, under an id
 * the clipboard carries beside the text. A paste into another composer, on any
 * machine, adds them and renumbers the references; a paste back into the same
 * composer is only text, since its references already name its pictures.
 */
export const IMAGE_CLIPBOARD_TYPE = 'application/x-boite-images';

interface Copied {
  id: string;
  text: string;
  from: ComposerState;
  /** Each reference number in `text` and the picture it named when copied. */
  images: Map<number, Attachment>;
}

/** The clipboard holds one thing at a time, and so does this. */
let last: Copied | null = null;

/** The images `selected` (the slice of `text` from `start`) names; empty when none. */
export function referencedImages(text: string, attachments: Attachment[], start: number, end: number): Map<number, Attachment> {
  const images = new Map<number, Attachment>();
  let at = 0;
  for (const part of imageTextParts(text, attachments)) {
    const from = at;
    at += part.text.length;
    // A picture still being read has no bytes to carry: its reference copies as text.
    if (!part.attachment || isLoading(part.attachment) || from < start || at > end) continue;
    images.set(Number(/\d+/.exec(part.text)![0]), part.attachment);
  }
  return images;
}

/**
 * Remembers a copy or cut from `from` and writes it to the clipboard. False
 * when the selection names no image: the browser's own copy is left alone.
 */
export function copyImages(clipboard: DataTransfer | null, from: ComposerState, start: number, end: number): boolean {
  if (!clipboard || end <= start) return false;
  const images = referencedImages(from.text, from.attachments, start, end);
  if (images.size === 0) return false;
  const text = from.text.slice(start, end);
  last = { id: crypto.randomUUID(), text, from, images };
  clipboard.setData('text/plain', text);
  clipboard.setData(IMAGE_CLIPBOARD_TYPE, JSON.stringify({ id: last.id }));
  return true;
}

/**
 * What the clipboard brings from a copy of ours: its id when the custom type
 * survived, the exact text otherwise. Null for anything else.
 */
export function copiedFrom(clipboard: DataTransfer | null): Copied | null {
  if (!clipboard || !last) return null;
  const raw = clipboard.getData(IMAGE_CLIPBOARD_TYPE);
  if (raw) {
    try {
      const id = (JSON.parse(raw) as { id?: unknown }).id;
      return id === last.id ? last : null;
    } catch { return null; }
  }
  return clipboard.getData('text/plain') === last.text ? last : null;
}

function sameImage(a: Attachment, b: Attachment): boolean {
  return a === b || (a.kind === b.kind && a.mimeType === b.mimeType && a.data === b.data);
}

/** True when every reference of the copy still names the same picture in `state`: plain text is enough. */
export function pastesAsText(copied: Copied, state: ComposerState): boolean {
  const images = state.attachments.filter(item => item.kind === 'image');
  return [...copied.images].every(([number, attachment]) => {
    const held = images[number - 1];
    return held !== undefined && sameImage(held, attachment);
  });
}

/**
 * The copy fitted to `attachments`: a picture already there keeps its number,
 * a new one is appended as a plain copy. `admit` gets the new ones and returns
 * those it accepts (caps, a provider without images). A reference whose picture
 * was refused leaves the pasted text.
 */
export function fitCopy(copied: Copied, attachments: Attachment[], admit: (incoming: Attachment[]) => Attachment[]): { text: string; attachments: Attachment[] } {
  const held = attachments.filter(item => item.kind === 'image');
  const numbers = new Map<number, number>();
  const incoming: { number: number; attachment: Attachment }[] = [];
  for (const [number, attachment] of copied.images) {
    const at = held.findIndex(item => sameImage(item, attachment));
    if (at >= 0) numbers.set(number, at + 1);
    else incoming.push({ number, attachment: { ...attachment } });
  }
  const accepted = admit(incoming.map(item => item.attachment));
  let count = held.length;
  for (const item of incoming) if (accepted.includes(item.attachment)) numbers.set(item.number, ++count);
  const text = copied.text.replace(/\[Image ([1-9]\d*)\]/g, (token, digits: string) => {
    const number = Number(digits);
    if (!copied.images.has(number)) return token;
    const target = numbers.get(number);
    return target === undefined ? '' : imageLabel(target);
  });
  return { text, attachments: [...attachments, ...incoming.map(item => item.attachment).filter(item => accepted.includes(item))] };
}

/** Tests start from an empty clipboard. */
export function forgetCopy(): void {
  last = null;
}
