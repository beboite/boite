import { afterEach, expect, test } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';

/** The composer measures its height once per keystroke, and again only when the text came from elsewhere. */

let running: Record<string, unknown> | null = null;

afterEach(() => {
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

test('a keystroke measures the composer once, a preview insertion still measures it', async () => {
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

  const field = document.querySelector<HTMLTextAreaElement>('[data-testid=composer-input]')!;
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
