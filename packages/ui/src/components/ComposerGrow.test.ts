import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';

/**
 * Where the engine sizes the box itself (`field-sizing: content`), a keystroke
 * reads no layout at all. Elsewhere the composer measures its height once per
 * keystroke, and again only when the text came from elsewhere.
 */

let running: Record<string, unknown> | null = null;

afterEach(() => {
  vi.restoreAllMocks();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('gave up waiting');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function openComposer(): Promise<HTMLTextAreaElement> {
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.composerStates = {};
  store.openThread = null;
  store.draft = null;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && store.openThread !== null);
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  return document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!;
}

test('a box that sizes itself reads no height on a keystroke', async () => {
  const field = await openComposer();
  let measures = 0;
  Object.defineProperty(field, 'scrollHeight', { configurable: true, get: () => { measures += 1; return 40; } });
  await settle();
  for (const text of ['h', 'he', 'hel']) {
    field.focus();
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
  }
  expect(measures).toBe(0);
  expect(field.style.height).toBe('');
});

test('without field-sizing a keystroke measures the composer once, a preview insertion still measures it', async () => {
  const supports = CSS.supports.bind(CSS) as (...args: string[]) => boolean;
  vi.spyOn(CSS, 'supports').mockImplementation(((...args: string[]) => args[0] === 'field-sizing' ? false : supports(...args)) as typeof CSS.supports);
  const field = await openComposer();
  let measures = 0;
  Object.defineProperty(field, 'scrollHeight', { configurable: true, get: () => { measures += 1; return 40; } });
  await settle();

  for (const text of ['h', 'he', 'hel']) {
    measures = 0;
    field.focus();
    field.value = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(measures).toBe(1);
  }

  // The paint layer over the field takes the width the measure read, scrollbar excluded.
  Object.defineProperty(field, 'clientWidth', { configurable: true, get: () => 612 });
  field.value = '/loop 2 check';
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  expect(document.querySelector<HTMLElement>('[data-testid=composer-highlight]')?.style.width).toBe('612px');

  measures = 0;
  store.addPreviewReference('t-trace', { id: 'grow', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 80, height: 30 } });
  await waitFor(() => field.value.includes('@Save'));
  await settle();
  expect(measures).toBeGreaterThan(0);
});
