import { afterEach, beforeEach, expect, test } from 'vitest';
import { appCommands, isAgentCommand, runCommand, slashName } from './commands.svelte';
import { setExperiment, writeExperiments } from './experiments';
import { FakeClient } from './fake-client';
import { Store } from './store.svelte';
import { THEME_STORAGE_KEY } from './theme';
import { work } from './work-prefs.svelte';

/**
 * The one list and the one dispatcher the palette and the composer's slash menu
 * both run on. Same fake as the palette's own test, same shape of check.
 */

let store: Store;

beforeEach(async () => {
  window.localStorage.clear();
  store = new Store();
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
});

afterEach(() => {
  writeExperiments([]);
  window.localStorage.clear();
  delete document.documentElement.dataset['theme'];
});

function ids(): string[] {
  return appCommands(store, false).map((item) => item.id);
}

test('the list carries every app command, the thread ones only while one is open', async () => {
  // The import and Agents rows ride behind their experiments, off until the switch is on.
  expect(ids()).not.toContain('import-session');
  expect(ids()).not.toContain('agents');
  setExperiment('session-import', true);
  setExperiment('resident-agents', true);
  expect(ids()).toEqual([
    'new-thread',
    'add-project',
    'import-session',
    'sidebar',
    'agents',
    'settings',
    'appearance',
    'archived',
    'providers',
    'pair',
    'tour',
    'theme-dark',
    'theme-light',
    'theme-system'
  ]);

  await store.open('t-descriptors');
  expect(ids()).toEqual([
    'new-thread',
    'add-project',
    'import-session',
    'pin',
    'rename',
    'retitle',
    'panel',
    'workflows',
    'changes',
    'files',
    'tasks',
    'trace',
    'terminal',
    'sidebar',
    'agents',
    'settings',
    'appearance',
    'archived',
    'providers',
    'pair',
    'tour',
    'theme-dark',
    'theme-light',
    'theme-system',
    'archive'
  ]);
  // Every one is a command, and none of them is an agent's.
  expect(appCommands(store, false).every((item) => item.kind === 'command')).toBe(true);
  expect(appCommands(store, false).some(isAgentCommand)).toBe(false);
});

test('runCommand dispatches: the theme is stored and stamped, settings opens on its tab', () => {
  runCommand(store, 'theme-dark', false);
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  // Dark is the palette on `:root`, so it removes the attribute rather than setting one.
  expect(document.documentElement.dataset['theme']).toBeUndefined();

  runCommand(store, 'theme-light', false);
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  expect(document.documentElement.dataset['theme']).toBe('light');

  runCommand(store, 'providers', false);
  expect(store.page).toBe('settings');
  expect(store.settingsTab).toBe('accounts');

  // Every entry opens the same machine and folder picker.
  store.showChat();
  runCommand(store, 'add-project', false);
  expect(store.page).toBe('chat');
  expect(store.projectPickerOpen).toBe(true);
  store.projectPickerOpen = false;

  // An id nothing answers does nothing at all.
  store.showChat();
  runCommand(store, 'no-such-command', false);
  expect(store.page).toBe('chat');
});

test('a hidden trace card stays in the palette, and Agents opens its page', async () => {
  await store.open('t-descriptors');
  // The palette is the way back to a button put away in Appearance.
  work.show('panel.trace', false);
  expect(ids()).toContain('trace');
  runCommand(store, 'trace', false);
  expect(store.panel.surfaces.some((surface) => surface.kind === 'trace')).toBe(true);
  work.show('panel.trace', true);

  runCommand(store, 'agents', false);
  expect(store.page).toBe('chat');
  setExperiment('resident-agents', true);
  runCommand(store, 'agents', false);
  expect(store.page).toBe('agents');
});

test('slashName reads the word a row completes to', () => {
  expect(slashName({ id: 'agent:shout', kind: 'command', label: '/shout' })).toBe('shout');
  expect(slashName({ id: 'theme-dark', kind: 'command', label: '/theme-dark' })).toBe('theme-dark');
  expect(isAgentCommand({ id: 'agent:shout', kind: 'command', label: '/shout' })).toBe(true);
});
