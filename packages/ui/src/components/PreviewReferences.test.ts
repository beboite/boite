import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { PreviewReference } from '@boite/contracts';
import type { Store } from '../lib/store.svelte';
import PreviewReferences from './PreviewReferences.svelte';

let running: Record<string, unknown> | null = null;

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
});

const TEXT = 'ultrathink about @Save';
const REFERENCE: PreviewReference = {
  id: 'save',
  url: 'https://example.test',
  selector: '#save',
  text: 'Save',
  bounds: { x: 0, y: 0, width: 80, height: 30 },
  mention: { start: 17, end: 22 }
};

function render(keywords: boolean, text = TEXT, references = [REFERENCE]): void {
  const store = { revealPreviewReference: async () => undefined } as unknown as Store;
  running = mount(PreviewReferences, { target: document.body, props: { text, references, store, threadId: 't', keywords } });
  flushSync();
}

test('a keyword glued to a reference is no keyword, as in the whole prompt', () => {
  render(true, 'look @Saveultrathink', [{ ...REFERENCE, mention: { start: 5, end: 10 } }]);
  expect(document.querySelector('[data-testid=preview-reference]')?.textContent).toBe('@Save');
  expect(document.querySelector('[data-testid=keyword-highlight]')).toBeNull();
  expect(document.body.textContent).toBe('look @Saveultrathink');
});

test('the text around a reference paints Claude keywords only when asked', () => {
  render(true);
  expect(document.querySelector('[data-testid=keyword-highlight]')?.textContent).toBe('ultrathink');
  expect(document.querySelector('[data-testid=preview-reference]')?.textContent).toBe('@Save');
  expect(document.body.textContent).toBe(TEXT);
  unmount(running!, { outro: false });
  running = null;

  render(false);
  expect(document.querySelector('[data-testid=keyword-highlight]')).toBeNull();
  expect(document.body.textContent).toBe(TEXT);
});
