import { expect, vi } from 'vitest';
import { LOGIN_URL, backToChat, loginLink, test, waitFor } from '../test/app';
import { openUrl } from '../test/opener';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('in the shell an external link goes to the system browser instead of the webview', async () => {
  const link = await loginLink();
  window.__TAURI_INTERNALS__ = {};

  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(click);

  await waitFor(() => openUrl.mock.calls.length === 1);
  expect(openUrl).toHaveBeenCalledWith(LOGIN_URL);
  expect(click.defaultPrevented).toBe(true);
  // The markup is untouched, so a right-click copy still works.
  expect(link.getAttribute('href')).toBe(LOGIN_URL);
  expect(link.getAttribute('target')).toBe('_blank');

  await backToChat();
});

test('outside the shell the same link goes through window.open', async () => {
  const opened = vi.fn(() => null);
  const original = window.open;
  window.open = opened as unknown as typeof window.open;
  try {
    const link = await loginLink();
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await waitFor(() => opened.mock.calls.length === 1);
    expect(opened).toHaveBeenCalledWith(LOGIN_URL, '_blank', 'noopener,noreferrer');
    expect(openUrl).not.toHaveBeenCalled();

    await backToChat();
  } finally {
    window.open = original;
  }
});

test.each([false, true])('a ctrl-click uses the opener only in the shell: %s', async (shell) => {
  const opened = vi.fn(() => null);
  const original = window.open;
  window.open = opened as unknown as typeof window.open;
  try {
    const link = await loginLink();
    if (shell) window.__TAURI_INTERNALS__ = {};
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true });
    link.dispatchEvent(click);

    await new Promise((resolve) => setTimeout(resolve, 20));
    if (shell) expect(openUrl).toHaveBeenCalledWith(LOGIN_URL);
    else expect(openUrl).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(shell);

    await backToChat();
  } finally {
    window.open = original;
  }
});
