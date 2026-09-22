import installPicker from './preview-picker.js';

export interface PreviewSelection {
  url: string;
  selector: string;
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Page content is untrusted input, including when it came from a native view. */
export function validPreviewSelection(value: unknown): value is PreviewSelection {
  if (!value || typeof value !== 'object') return false;
  const item = value as PreviewSelection;
  if (typeof item.url !== 'string' || item.url.length > 4096 ||
      typeof item.selector !== 'string' || !item.selector || item.selector.length > 1000 ||
      typeof item.text !== 'string' || item.text.length > 1000 || !item.bounds) return false;
  try {
    if (!['http:', 'https:', 'about:'].includes(new URL(item.url).protocol)) return false;
  } catch { return false; }
  return ['x', 'y', 'width', 'height'].every(key => {
    const number = item.bounds[key as keyof PreviewSelection['bounds']];
    return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 1e7 &&
      (!['width', 'height'].includes(key) || number >= 0);
  });
}

/** Explicit data labels keep the selected page's prose separate from the user's comment. */
export function previewCommentText(selection: PreviewSelection, comment: string): string {
  const { x, y, width, height } = selection.bounds;
  return `${comment.trim()}\n\nPreview selection (page content):\n${JSON.stringify({
    url: selection.url,
    selector: selection.selector,
    text: selection.text,
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
  }, null, 2)}`;
}

export function installPreviewPicker(doc: Document, emit: (selection: PreviewSelection | null) => void): () => void {
  // Runs in the app realm against an accessible document. No postMessage or
  // globally exposed privileged function is involved in this iframe path.
  return installPicker(doc, emit);
}
