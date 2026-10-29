import { afterEach, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { store } from '../lib/store.svelte';
import { confirm } from '../lib/confirm.svelte';
import { mountOnFake, press, query, test, waitFor } from '../test/app';

vi.mock('@tauri-apps/plugin-opener', () => import('../test/opener'));
afterEach(() => vi.restoreAllMocks());

function touch(narrow = true) {
  const original = window.matchMedia;
  vi.spyOn(window, 'matchMedia').mockImplementation(media => Object.assign(original(media), {
    matches: media === '(pointer: coarse)' || (narrow && media.includes('max-width: 720px'))
  }));
}

function typing() {
  return document.activeElement?.matches('textarea, input:not([type=checkbox]):not([type=radio]), [contenteditable=true]') ?? false;
}

test('opening a thread with choices and answering them leaves the touch keyboard closed', async () => {
  touch();
  await mountOnFake();
  const threadId = store.openThread!.id;
  const question = await store.client!.call('questions.ask', { threadId, text: 'Which checks?', options: ['Unit', 'Browser'] });
  store.startDraft(store.openThread!.projectId);
  await store.open(threadId);
  await waitFor(() => document.querySelector('[data-testid=question-option]') !== null);
  expect(typing()).toBe(false);
  query<HTMLButtonElement>('[data-testid=question-option]').click();
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  query<HTMLButtonElement>('[data-testid=composer-send]').click();
  await waitFor(() => !store.pendingQuestions.some(pending => pending.id === question.questionId));
  expect(typing()).toBe(false);
  store.startDraft(store.openThread!.projectId);
  flushSync();
  expect(typing()).toBe(false);
});

test('closing an overlay on touch does not reopen the previously focused composer', async () => {
  touch();
  await mountOnFake();
  query<HTMLTextAreaElement>('[data-testid=composer-input]').focus();
  const answer = confirm.ask({ title: 'Continue?', confirmLabel: 'Continue', cancelLabel: 'Cancel' });
  await waitFor(() => document.activeElement?.matches('[data-confirm]') === true);
  query<HTMLButtonElement>('[data-confirm]').click();
  await answer;
  flushSync();
  expect(typing()).toBe(false);
  expect(document.activeElement).not.toBe(document.body);
});

test('Escape after closing an overlay on touch preserves a question waiting for an answer', async () => {
  touch();
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  await store.send('one question please', 't-trace');
  await waitFor(() => document.querySelector('[data-testid=composer-reply]') !== null);
  const stop = vi.spyOn(store, 'stop');
  const answer = confirm.ask({ title: 'Continue?', confirmLabel: 'Continue', cancelLabel: 'Cancel' });
  await waitFor(() => document.activeElement?.matches('[data-confirm]') === true);
  query<HTMLButtonElement>('[data-confirm]').click();
  await answer;
  flushSync();
  expect(document.activeElement).toBe(query('[data-testid=composer]'));
  press('Escape');
  expect(stop).not.toHaveBeenCalled();
  expect(store.busy).toBe(true);
  expect(document.querySelector('[data-testid=question-card][data-state=pending]')).not.toBeNull();
  query<HTMLButtonElement>('[data-testid=composer-reply-ignore]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-reply]') === null);
  query('[data-testid=composer]').focus();
  press('Escape');
  expect(stop).toHaveBeenCalledTimes(1);
});

test('browsing project folders on touch focuses the dialog instead of its path field', async () => {
  touch();
  await mountOnFake();
  store.projectPickerOpen = true;
  await waitFor(() => document.querySelector<HTMLInputElement>('[data-testid=project-path]')?.value === '/workspace');
  expect(typing()).toBe(false);
  expect(document.activeElement?.closest('[data-testid=project-picker]')).not.toBeNull();
  query<HTMLButtonElement>('[data-testid=project-cancel]').click();
});

test('Shift+Tab from a touch confirmation frame stays inside the dialog', async () => {
  touch();
  await mountOnFake();
  const answer = confirm.ask({ title: 'Remove project?', confirmLabel: 'Remove', cancelLabel: 'Cancel', requiredText: 'project' });
  await waitFor(() => document.activeElement?.matches('[data-testid=confirm-dialog]') === true);
  try {
    const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(backwards);
    expect(backwards.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(query('[data-testid=confirm-cancel]'));
  } finally {
    confirm.answer(false);
    await answer;
  }
});

test('Shift+Tab from a touch report frame stays inside the dialog', async () => {
  touch();
  await mountOnFake();
  store.showSettings('diagnostics');
  await waitFor(() => document.querySelector('[data-testid=diagnostics-report]') !== null);
  query<HTMLButtonElement>('[data-testid=diagnostics-report]').click();
  await waitFor(() => document.activeElement?.matches('[data-testid=diagnostics-report-dialog]') === true);
  const backwards = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  document.activeElement!.dispatchEvent(backwards);
  expect(backwards.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(query('[data-testid=diagnostics-report-dialog] .actions .ghost'));
});

test('a wide touch device does not focus the model search automatically', async () => {
  touch(false);
  await mountOnFake();
  const original = store.modelsOf.bind(store);
  const providerId = store.openThread!.providerId;
  const models = Array.from({ length: 65 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }));
  vi.spyOn(store, 'modelsOf').mockImplementation((provider, account) => provider === providerId ? models : original(provider, account));
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-show-all]') !== null);
  expect(typing()).toBe(false);
  query<HTMLButtonElement>('[data-testid=picker-show-all]').click();
  await waitFor(() => document.querySelector('[data-testid=picker-show-all]') === null);
  expect(typing()).toBe(false);
});

test('opening a terminal on touch leaves its output readable without opening the keyboard', async () => {
  touch();
  await mountOnFake();
  store.toggleTerminal();
  await waitFor(() => document.querySelector('[data-testid=terminal-drawer]')?.textContent?.includes('PS ') === true);
  expect(typing()).toBe(false);
  query<HTMLTextAreaElement>('.xterm-helper-textarea').focus();
  expect(typing()).toBe(true);
});

test('previewing an attached image on touch does not turn composer navigation into typing', async () => {
  touch();
  await mountOnFake();
  const field = query<HTMLTextAreaElement>('[data-testid=composer-input]');
  field.dispatchEvent(new Event('input', { bubbles: true }));
  store.composerStates[store.openThread!.id]!.attachments = [{ kind: 'image', mimeType: 'image/png', data: 'aW1hZ2U=', name: 'draft.png' }];
  await waitFor(() => document.querySelector('[data-testid=composer-image-open]') !== null);
  query('[data-testid=composer]').focus();
  query<HTMLButtonElement>('[data-testid=composer-image-open]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-image-preview]') !== null);
  expect(typing()).toBe(false);
  field.focus();
  query<HTMLButtonElement>('[data-testid=composer-image-close]').click();
  expect(document.activeElement).toBe(field);
});

test('asking to write an answer still focuses the composer on touch', async () => {
  touch();
  await mountOnFake();
  await store.client!.call('questions.ask', { threadId: store.openThread!.id, text: 'Your answer?', options: ['Yes'] });
  await waitFor(() => document.querySelector('[data-testid=composer-reply-ignore]') !== null);
  query<HTMLButtonElement>('[data-testid=composer-reply-ignore]').click();
  await waitFor(() => document.querySelector('[data-testid=question-write]') !== null);
  query<HTMLTextAreaElement>('[data-testid=composer-input]').blur();
  query<HTMLButtonElement>('[data-testid=question-write]').click();
  expect(document.activeElement).toBe(query('[data-testid=composer-input]'));
});

test('desktop navigation and overlay dismissal retain composer focus', async ({ app: _app }) => {
  expect(document.activeElement).toBe(query('[data-testid=composer-input]'));
  const answer = confirm.ask({ title: 'Continue?', confirmLabel: 'Continue', cancelLabel: 'Cancel' });
  await waitFor(() => document.activeElement?.matches('[data-confirm]') === true);
  query<HTMLButtonElement>('[data-confirm]').click();
  await answer;
  flushSync();
  expect(document.activeElement).toBe(query('[data-testid=composer-input]'));
});
