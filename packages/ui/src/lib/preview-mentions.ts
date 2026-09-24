import type { PreviewReference } from '@boite/contracts';
import { previewReferenceLabel } from './preview-comments';

/** Native textarea edits shift intact mentions; editing a token makes it plain text. */
export function editPreviewMentions(before: string, after: string, references: PreviewReference[], edit?: { start: number; end: number }): PreviewReference[] {
  if (before === after && !edit) return references;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let oldEnd = before.length, newEnd = after.length;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  if (edit) {
    const end = edit.end + after.length - before.length;
    if (end >= edit.start && before.slice(0, edit.start) === after.slice(0, edit.start) && before.slice(edit.end) === after.slice(end)) {
      start = edit.start; oldEnd = edit.end; newEnd = end;
    }
  }
  const shift = newEnd - oldEnd;
  return references.flatMap(reference => {
    const range = reference.mention;
    if (!range) return [reference];
    if (range.end <= start) return [reference];
    if (range.start >= oldEnd) return [{ ...reference, mention: { start: range.start + shift, end: range.end + shift } }];
    return [];
  });
}

export function insertPreviewMention(text: string, references: PreviewReference[], reference: PreviewReference, start = text.length, end = start) {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  const label = previewReferenceLabel(reference);
  const prefix = start > 0 && !/\s/.test(text[start - 1]!) ? ' ' : '';
  const suffix = end < text.length && !/\s/.test(text[end]!) ? ' ' : '';
  const value = text.slice(0, start) + prefix + label + suffix + text.slice(end);
  const mention = { start: start + prefix.length, end: start + prefix.length + label.length };
  return { text: value, references: [...editPreviewMentions(text, value, references, { start, end }), { ...reference, mention }], caret: mention.end + suffix.length };
}

export type PreviewTextPart = { text: string; reference?: PreviewReference };

export function restorePreviewMentions(text: string, references: PreviewReference[]) {
  let value = { text, references: references.filter(reference => reference.mention) };
  for (const reference of references.filter(reference => !reference.mention)) value = insertPreviewMention(value.text, value.references, reference);
  return value;
}

export function previewTextParts(text: string, references: PreviewReference[]): PreviewTextPart[] {
  const parts: PreviewTextPart[] = [];
  let at = 0;
  for (const reference of [...references].filter(ref => ref.mention).sort((a, b) => a.mention!.start - b.mention!.start)) {
    const range = reference.mention!;
    if (range.start < at || range.end > text.length || text[range.start] !== '@') continue;
    if (range.start > at) parts.push({ text: text.slice(at, range.start) });
    parts.push({ text: text.slice(range.start, range.end), reference });
    at = range.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  // Messages written before inline mentions retain their clickable references.
  for (const reference of references.filter(ref => !ref.mention)) parts.push({ text: ` ${previewReferenceLabel(reference)}`, reference });
  return parts;
}
