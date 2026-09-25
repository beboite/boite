import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { archiveThread } from '../lib/archive';

/** The phone has no General page: the archive it can fill must be reachable from its own settings list. */

const { openUrl } = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => {}) }));
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }));

let running: Record<string, unknown> | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
});

async function waitFor(check: () => boolean, attempts = 2000): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`gave up waiting, body was:\n${document.body.textContent ?? ''}`);
}

function query<T extends Element = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found;
}

/** A phone-width window: only the layout query answers yes. */
function phoneWidth() {
  vi.stubGlobal('matchMedia', (media: string) => Object.assign(new EventTarget(), {
    media, matches: media.includes('max-width: 720px'), onchange: null, addListener() {}, removeListener() {}
  }));
}

test('a thread archived on the phone comes back from its own settings list', async () => {
  phoneWidth();
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  store.booted = false;
  store.openThread = null;
  store.draft = null;
  store.page = 'chat';
  store.composerStates = {};
  store.projectPickerOpen = false;
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && (store.openThread !== null || store.draft !== null));

  expect(await archiveThread(store, 't-trace')).toBe(true);
  await waitFor(() => !store.threads.some((t) => t.id === 't-trace' && !t.archived));
  store.showSettings('general');
  await waitFor(() => document.querySelector('[data-testid=mobile-settings-home]') !== null);
  query<HTMLButtonElement>('[data-testid=mobile-settings-archived]').click();
  await waitFor(() => document.querySelector('[data-testid=archived-show]') !== null);
  expect(query('[data-testid=mobile-settings-detail]').textContent).toContain('Restore it to bring the conversation back');
  query<HTMLButtonElement>('[data-testid=archived-show]').click();
  await waitFor(() => document.querySelector('[data-testid=archived-restore]') !== null);
  expect(query('[data-testid=archived-list]').textContent).toContain('Finish the trace tab');
  query<HTMLButtonElement>('[data-testid=archived-restore]').click();
  await waitFor(() => store.threads.find((t) => t.id === 't-trace')?.archived === false);

  query<HTMLButtonElement>('[data-testid=mobile-settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=mobile-settings-home]') !== null);
});
