import installPicker from './preview-picker.js';
import { previewReferencesError, type PreviewReference } from '@boite/contracts';

export interface PreviewSelection {
  url: string;
  selector: string;
  shadowPath?: string[];
  text: string;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Page content is untrusted input, including when it came from a native view. */
export function validPreviewSelection(value: unknown): value is PreviewSelection {
  return !!value && typeof value === 'object' && previewReferencesError([{ ...value, id: 'selection' }]) === null;
}

export function previewReferenceLabel(reference: PreviewReference): string {
  return `@${reference.text.trim().replace(/\s+/g, ' ').slice(0, 40) || reference.selector.split(' > ').at(-1)?.slice(0, 40) || 'element'}`;
}

export function installPreviewPicker(doc: Document, emit: (selection: PreviewSelection | null) => void): () => void {
  // Runs in the app realm against an accessible document. No postMessage or
  // globally exposed privileged function is involved in this iframe path.
  return installPicker(doc, emit);
}
