import { expect, vi } from 'vitest';
import { store } from '../lib/store.svelte';
import { press, query, test, type, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));

test('the theme setting stamps the light palette and remembers the choice', async ({ app: _app }) => {
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  // The theme lives on its own tab now, not on General.
  await waitFor(() => document.querySelector('[data-testid=settings-tab-appearance]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-appearance]').click();
  await waitFor(() => document.querySelector('[data-testid=theme-light]') !== null);
  expect(query('[data-testid=theme-system]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-testid=theme-light]').click();
  await waitFor(() => document.documentElement.dataset.theme === 'light');
  expect(window.localStorage.getItem('boite.theme')).toBe('light');
  expect(query('[data-testid=theme-light]').getAttribute('aria-pressed')).toBe('true');

  query<HTMLButtonElement>('[data-testid=theme-dark]').click();
  await waitFor(() => document.documentElement.dataset.theme === undefined);
  expect(window.localStorage.getItem('boite.theme')).toBe('dark');
  expect(query('[data-testid=theme-dark]').getAttribute('aria-pressed')).toBe('true');

  // The store is one module-level singleton: leave the next test on the chat.
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('the keybindings file moves a chord, takes one away, and the Keyboard page says so', async ({ app: _app }) => {
  await waitFor(() => store.keybindings !== null);

  // The fake's file binds the light theme to Ctrl+Shift+L and unbinds the panel.
  const light = new KeyboardEvent('keydown', { key: 'L', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(light)).toBe(false);
  await waitFor(() => document.documentElement.dataset.theme === 'light');

  await waitFor(() => store.openThread !== null);
  const panel = new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, altKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(panel)).toBe(true);
  expect(store.panelOpen).toBe(false);

  // A default still stands, and the tooltip and the palette hint read the table too.
  expect(query<HTMLButtonElement>('[data-testid=nav-settings]').title).toBe('Settings (Ctrl+,)');
  const settings = new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true, cancelable: true });
  expect(document.body.dispatchEvent(settings)).toBe(false);
  await waitFor(() => document.querySelector('[data-testid=settings-tab-keyboard]') !== null);

  query<HTMLButtonElement>('[data-testid=settings-tab-keyboard]').click();
  await waitFor(() => document.querySelector('[data-testid=keyboard-page]') !== null);
  const keyOf = (id: string) =>
    query(`[data-testid=keybinding-row][data-command=${id}] [data-testid=keybinding-key]`).textContent?.trim();
  expect(keyOf('theme-light')).toBe('Ctrl+Shift+L');
  expect(keyOf('panel')).toBe('Not set');
  expect(keyOf('new-thread')).toBe('Ctrl+N');
  expect(query('[data-testid=keybinding-row][data-command=theme-light]').classList.contains('custom')).toBe(true);
  expect(query('[data-testid=keybinding-row][data-command=new-thread]').classList.contains('custom')).toBe(false);
  expect(query('[data-testid=keybindings-path]').textContent).toBe('C:\\Users\\you\\AppData\\Local\\boite2\\keybindings.json');
  expect(query('[data-testid=keybinding-error]').textContent).toContain('"trace": "t" has no modifier');

  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});

test('a shortcut is recorded from the keys pressed, a taken one asks first, and reset puts the defaults back', async ({ app: _app }) => {
  store.showSettings('keyboard');
  await waitFor(() => document.querySelector('[data-testid=keyboard-page]') !== null);
  const row = (id: string) => `[data-testid=keybinding-row][data-command=${id}]`;
  const keyOf = (id: string) => query(`${row(id)} [data-testid=keybinding-key]`).textContent?.replace(/\s+/g, '');
  const press = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

  query<HTMLButtonElement>(`${row('pin')} [data-testid=keybinding-edit]`).click();
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-capture]`) !== null);
  // Modifiers alone wait; a bare letter is typing and is refused on the row.
  press({ key: 'Control', ctrlKey: true });
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-capture]`)?.textContent?.includes('Ctrl') === true);
  press({ key: 'p' });
  await waitFor(() => document.querySelector(`${row('pin')} [role=alert]`) !== null);
  press({ key: 'p', ctrlKey: true, altKey: true });
  await waitFor(() => store.bindings.pin.text === 'mod+alt+p');
  await waitFor(() => keyOf('pin') === 'Ctrl+Alt+P');
  expect(query(row('pin')).classList.contains('custom')).toBe(true);
  // The recorded chord ran nothing on its way in.
  expect(store.page).toBe('settings');

  query<HTMLButtonElement>(`${row('pin')} [data-testid=keybinding-edit]`).click();
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-capture]`) !== null);
  press({ key: 'k', ctrlKey: true });
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-conflict]`) !== null);
  expect(store.bindings.palette.text).toBe('mod+k');
  query<HTMLButtonElement>('[data-testid=keybinding-replace]').click();
  await waitFor(() => store.bindings.pin.text === 'mod+k' && store.bindings.palette.text === null);

  query<HTMLButtonElement>(`${row('pin')} [data-testid=keybinding-reset]`).click();
  await waitFor(() => store.bindings.pin.text === null && !store.bindings.pin.custom);
  query<HTMLButtonElement>('[data-testid=keybindings-reset-all]').click();
  await waitFor(() => store.bindings.palette.text === 'mod+k' && store.bindings['theme-light'].text === null);
  expect(document.querySelector('[data-testid=keybindings-reset-all]')).toBeNull();

  // Moving to the filter ends the recording, so its keys type instead of binding.
  query<HTMLButtonElement>(`${row('pin')} [data-testid=keybinding-edit]`).click();
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-capture]`) !== null);
  query('[data-testid=keybindings-filter]').dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  await waitFor(() => document.querySelector(`${row('pin')} [data-testid=keybinding-capture]`) === null);
  expect(press({ key: 'p', ctrlKey: true, altKey: true })).toBe(true);
  expect(store.bindings.pin.text).toBe(null);
});

test('the checklist model sits with the conversation settings on General, with no experiment on', async ({ app: _app }) => {
  expect(window.localStorage.getItem('boite.experiments')).toBeNull();
  query<HTMLButtonElement>('[data-testid=nav-settings]').click();
  await waitFor(() => document.querySelector('[data-testid=settings-tab-general]') !== null);
  query<HTMLButtonElement>('[data-testid=settings-tab-general]').click();
  await waitFor(() => document.querySelector('[data-testid=goal-tracker]') !== null);
  const tracker = query('[data-testid=goal-tracker]');
  expect(tracker.closest('#settings-conversations')?.querySelector('[data-testid=setting-title-model]')).not.toBeNull();
  expect(query('[data-testid=goal-tracker-model]').textContent).toContain('Automatic');
  query<HTMLButtonElement>('[data-testid=settings-back]').click();
  await waitFor(() => document.querySelector('[data-testid=settings]') === null);
});
