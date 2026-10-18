import { afterEach, expect, test, vi } from 'vitest';
import { showBootFailure } from './boot-failure';
import { setLocaleSetting } from './i18n.svelte';

afterEach(async () => {
  await setLocaleSetting('system');
  document.body.replaceChildren();
});

test('the notice speaks the language of the page and retries once, on a click or on the way back online', async () => {
  await setLocaleSetting('fr');
  const target = document.body.appendChild(document.createElement('div'));
  const retry = vi.fn(async () => undefined);
  showBootFailure(target, retry);
  const note = target.querySelector<HTMLElement>('[data-testid=boot-failure]')!;
  expect(note.getAttribute('role')).toBe('alert');
  expect(note.textContent).toContain('Réessayer');

  note.querySelector('button')!.click();
  expect(retry).toHaveBeenCalledOnce();
  expect(target.childElementCount).toBe(0);
  // The listener went with the notice: a later `online` is not a second boot.
  window.dispatchEvent(new Event('online'));
  expect(retry).toHaveBeenCalledOnce();

  await setLocaleSetting('en');
  showBootFailure(target, retry);
  expect(target.textContent).toContain('Try again');
  window.dispatchEvent(new Event('online'));
  expect(retry).toHaveBeenCalledTimes(2);
  expect(target.childElementCount).toBe(0);
});

test('a retry that fails again draws the notice back while the core is out of reach, and reloads once it answers', async () => {
  const target = document.body.appendChild(document.createElement('div'));
  const reload = vi.fn();
  const retry = vi.fn(() => Promise.reject(new Error('offline')));
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  try {
    showBootFailure(target, retry, reload);
    target.querySelector('button')!.click();
    await vi.waitFor(() => expect(target.querySelector('[data-testid=boot-failure]')).not.toBeNull());
    expect(reload).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
  }
});
