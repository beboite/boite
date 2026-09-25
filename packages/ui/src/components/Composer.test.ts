import { afterEach, expect, test, vi } from 'vitest';
import { mount, unmount } from 'svelte';
import App from '../App.svelte';
import { defaultPrefs, PREFS_STORAGE_KEY, STASH_STORAGE_KEY } from '../lib/prefs';
import { store } from '../lib/store.svelte';
import { closeTour } from '../lib/onboarding.svelte';
import { freshWork, work, WORK_STORAGE_KEY } from '../lib/work-prefs.svelte';

/**
 * The three composer keys, on the whole app over the in-memory fake: Ctrl+Enter
 * sends and opens the next draft, ArrowUp walks this thread's sent prompts, and
 * Ctrl+S puts the text aside and takes it back. Then the reasoning chip, which
 * carries the level the picker used to hide.
 */

let running: Record<string, unknown> | null = null;

const previewReference = { id: 'composer-element', url: 'https://example.test', selector: '#save', text: 'Save', bounds: { x: 0, y: 0, width: 80, height: 30 } };

test('preview mentions insert at the caret inside prose and keep identical labels distinct', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  await type('Change this please');
  input().setSelectionRange(7, 11);
  input().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  store.addPreviewReference('t-trace', previewReference);
  await waitFor(() => input().value === 'Change @Save please');
  expect(query('[data-testid="composer"] .input-wrap [data-testid="preview-reference"]').textContent).toBe('@Save');
  input().setSelectionRange(input().value.length, input().value.length);
  input().dispatchEvent(new MouseEvent('click', { bubbles: true }));
  store.addPreviewReference('t-trace', { ...previewReference, id: 'other-element', selector: '#other' });
  await waitFor(() => input().value === 'Change @Save please @Save');
  expect(store.composerStates['t-trace']!.previewReferences?.map(ref => ref.id)).toEqual(['composer-element', 'other-element']);
  await type('Change @Save please');
  expect(store.composerStates['t-trace']!.previewReferences?.map(ref => ref.id)).toEqual(['composer-element']);
  await type('Change @Sav please');
  expect(store.composerStates['t-trace']!.previewReferences).toEqual([]);
});

test('an intact preview mention never opens file completion, while editing it restores file completion', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  const call = vi.spyOn(store.client!, 'call');
  store.addPreviewReference('t-trace', previewReference);
  await waitFor(() => input().value === '@Save');
  input().focus();
  for (const at of [2, 5]) {
    input().setSelectionRange(at, at);
    input().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 90));
    expect(mentionMenu()).toBeNull();
    expect(call.mock.calls.filter(([method]) => method === 'projects.files')).toEqual([]);
  }
  await type('@Sav');
  expect(store.composerStates['t-trace']!.previewReferences).toEqual([]);
  await waitFor(() => call.mock.calls.some(([method]) => method === 'projects.files'));
  expect(mentionMenu()).not.toBeNull();
});

test('preview references survive queuing and a failed drain, and stashing refuses without changing the draft', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  await type('Change the selected control');
  store.addPreviewReference('t-trace', previewReference);
  const reference = store.composerStates['t-trace']!.previewReferences![0]!;
  await waitFor(() => input().value.endsWith('@Save'));
  input().focus();
  press('s', { ctrlKey: true });
  expect(store.error).toContain('cannot be stashed');
  expect(input().value).toBe('Change the selected control @Save');
  expect(store.composerStates['t-trace']?.previewReferences).toEqual([reference]);
  const send = vi.spyOn(store, 'send').mockResolvedValue(false);
  store.openThread!.status = 'running';
  await new Promise(resolve => setTimeout(resolve, 0));
  press('Enter');
  await waitFor(() => store.composerStates['t-trace']?.queued.length === 1);
  expect(store.composerStates['t-trace']!.queued[0]!.previewReferences).toEqual([reference]);
  expect(store.composerStates['t-trace']!.previewReferences).toEqual([]);
  store.openThread!.status = 'idle';
  await waitFor(() => store.composerStates['t-trace']?.paused === true);
  expect(send).toHaveBeenCalledWith('Change the selected control @Save', 't-trace', [], [reference]);
  expect(store.composerStates['t-trace']!.text).toBe('Change the selected control @Save');
  expect(store.composerStates['t-trace']!.previewReferences).toEqual([reference]);
});

test('preview references remain after refused activity commands and return with recalled sent prompts', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => !store.busy);
  await type('/goal Change the control');
  store.addPreviewReference('t-trace', previewReference);
  await waitFor(() => input().value.endsWith('@Save'));
  input().focus(); press('Enter');
  await waitFor(() => !!store.error?.includes('references cannot be used'));
  expect(store.composerStates['t-trace']!.previewReferences).toHaveLength(1);
  await send('Change the control @Save');
  expect(store.composerStates['t-trace']!.previewReferences).toEqual([]);
  expect(query('[data-role="user"] [data-testid="preview-reference"]').textContent).toBe('@Save');
  input().focus(); press('ArrowUp');
  await waitFor(() => input().value === 'Change the control @Save');
  expect(store.composerStates['t-trace']!.previewReferences?.[0]?.id).toBe(previewReference.id);
  await type('Change the control');
  await waitFor(() => !document.querySelector('[data-testid="composer"] [data-testid="preview-reference"]'));
  expect(input().value).toBe('Change the control');
});

afterEach(() => {
  if (running) unmount(running, { outro: false });
  running = null;
  document.body.innerHTML = '';
  window.localStorage.clear();
  // The device's pins are module state: the next test starts with no record.
  work.load();
  vi.restoreAllMocks();
});

async function waitFor(check: () => boolean, attempts = 400): Promise<void> {
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

function input(): HTMLTextAreaElement {
  return query<HTMLTextAreaElement>('[data-testid=composer-input]');
}

/** A key on whatever holds the focus; false back means something took it. */
function press(key: string, init: KeyboardEventInit = {}): boolean {
  const target = document.activeElement ?? document.body;
  return target.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  );
}

/** Type into the composer the way a user does, then let the effects settle. */
async function type(text: string): Promise<void> {
  const field = input();
  field.focus();
  field.value = text;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mountOnFake(): Promise<void> {
  window.history.replaceState(null, '', '/?fake=1&open=recent');
  const target = document.createElement('div');
  document.body.appendChild(target);
  // The store is a singleton: the previous test's thread and its draft would
  // otherwise stand, and a boot that already has one opens nothing.
  store.booted = false;
  store.composerStates = {};
  store.openThread = null;
  store.draft = null;
  // The tour would be up over the composer on a device that has not seen it.
  closeTour();
  running = mount(App, { target });
  await waitFor(() => store.booted && store.openThread !== null);
}

/** One finished turn on the thread that is open, sent from the composer. */
async function send(prompt: string): Promise<void> {
  await waitFor(() => !store.busy);
  const before = store.openThread?.messages.length ?? 0;
  await type(prompt);
  input().focus();
  press('Enter');
  await waitFor(() => (store.openThread?.messages.length ?? 0) >= before + 2 && !store.busy);
}

test('Ctrl+Enter sends and leaves a fresh draft open on the same picker values', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  const thread = store.openThread;
  if (!thread) throw new Error('no open thread');
  const before = store.threads.length;

  await type('Send this one and give me the next box');
  input().focus();
  expect(press('Enter', { ctrlKey: true })).toBe(false);

  await waitFor(() => store.draft !== null && store.openThread === null);
  // The prompt went into the thread it was typed in, and no thread was created.
  expect(store.threads.length).toBe(before);
  const sentTo = await store.client?.call('threads.get', { threadId: 't-trace' });
  expect(sentTo?.messages.filter((m) => m.role === 'user').at(-1)?.parts).toEqual([
    { type: 'text', text: 'Send this one and give me the next box' }
  ]);

  // The draft sits in the same project, on the same five values, and the
  // composer has the keyboard, exactly like Ctrl+N.
  expect(store.draft?.projectId).toBe(thread.projectId);
  expect(store.defaultChoice()).toEqual({
    providerId: thread.providerId,
    accountId: thread.accountId,
    permissionMode: thread.permissionMode,
    model: thread.model,
    effort: thread.effort,
    speed: null
  });
  expect(input().value).toBe('');
  await waitFor(() => document.activeElement === input());

  // The same key on that draft: the thread is created first, then the next draft.
  await type('And one more thread');
  input().focus();
  press('Enter', { ctrlKey: true });
  await waitFor(() => store.threads.length === before + 1);
  await waitFor(() => store.draft !== null && store.openThread === null);
  expect(store.threads.at(-1)?.title).toBe('And one more thread');
  expect(store.draft?.projectId).toBe(thread.projectId);
});

test('ArrowUp recalls the sent prompts of this thread and ArrowDown comes back', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);

  await send('the older one');
  await send('the newer one');
  await waitFor(() => input().value === '');

  input().focus();
  expect(press('ArrowUp')).toBe(false);
  expect(input().value).toBe('the newer one');
  // The caret sits at the end of what was recalled.
  expect(input().selectionStart).toBe('the newer one'.length);

  press('ArrowUp');
  expect(input().value).toBe('the older one');

  // One older again is the prompt the thread was seeded with.
  press('ArrowUp');
  expect(input().value).toBe('What does the trace tab need from the core?');
  // Nothing older: the oldest stays, and the caret does not run off.
  press('ArrowUp');
  expect(input().value).toBe('What does the trace tab need from the core?');

  press('ArrowDown');
  expect(input().value).toBe('the older one');
  press('ArrowDown');
  expect(input().value).toBe('the newer one');
  // Past the newest the composer is empty again.
  press('ArrowDown');
  expect(input().value).toBe('');
  // And past that, ArrowDown is the caret's own key once more.
  expect(press('ArrowDown')).toBe(true);

  // Typing leaves recall, so the next ArrowUp starts from the most recent.
  await type('something of my own');
  expect(press('ArrowUp')).toBe(true);
  expect(input().value).toBe('something of my own');
  await type('');
  press('ArrowUp');
  expect(input().value).toBe('the newer one');
});

test('Ctrl+S stashes the composer under the thread, and an empty one takes it back', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);

  await type('a prompt I am not ready to send');
  input().focus();
  expect(press('s', { ctrlKey: true })).toBe(false);

  expect(input().value).toBe('');
  expect(JSON.parse(window.localStorage.getItem(STASH_STORAGE_KEY) ?? 'null')).toEqual({
    't-trace': 'a prompt I am not ready to send'
  });

  // The empty composer takes it back, and the stash is spent.
  input().focus();
  press('s', { ctrlKey: true });
  expect(input().value).toBe('a prompt I am not ready to send');
  expect(input().selectionStart).toBe('a prompt I am not ready to send'.length);
  expect(window.localStorage.getItem(STASH_STORAGE_KEY)).toBeNull();

  // The browser's own save dialog stays shut wherever the focus is.
  input().blur();
  expect(press('s', { ctrlKey: true })).toBe(false);
});

/** The reasoning chip of the composer bar, or null while the model offers no scale. */
function effortChip(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid=composer-effort]');
}

/** The level names the open reasoning slider writes under its track, in order. */
function effortRows(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-effort-menu] [data-value]')).map((el) =>
    el.getAttribute('data-value')
  );
}

/** The dots on that track, one per level. */
function effortDots(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-testid=composer-effort-menu] [data-dot]')).map((el) =>
    el.getAttribute('data-dot')
  );
}

async function openDraft(): Promise<void> {
  query<HTMLButtonElement>('[data-testid=new-thread]').click();
  await waitFor(() => store.draft !== null);
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Opus 5') === true);
}

test('the reasoning chip reads the model default level and saves the pick on the open thread', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  // The thread runs the echo model, whose scale is two levels with high as its default.
  expect(store.openThread?.effort).toBeNull();
  await waitFor(() => effortChip() !== null);
  expect(effortChip()?.textContent?.trim()).toBe('High');

  const update = vi.spyOn(store, 'update');
  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortRows()).toEqual(['low', 'high']);

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=low]').click();
  await waitFor(() => store.openThread?.effort === 'low');
  expect(update).toHaveBeenCalledWith('t-trace', { accountId: 'a-echo', model: 'echo-1', effort: 'low', speed: null, expectedSelectionVersion: 0 });
  // The chip names the level that is live, and the picker's own label leaves it alone.
  await waitFor(() => effortChip()?.textContent?.trim() === 'Low');
  expect(query('[data-testid=composer-picker]').textContent).not.toContain('Low');
});

test('the reasoning chip remembers the level a draft picks', async () => {
  await mountOnFake();
  await openDraft();
  await waitFor(() => effortChip() !== null);
  expect(effortChip()?.textContent?.trim()).toBe('High');

  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  expect(effortRows()).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink']);

  query<HTMLButtonElement>('[data-testid=composer-effort-menu] [data-value=xhigh]').click();
  await waitFor(() => store.prefs.effort === 'xhigh');
  expect(JSON.parse(window.localStorage.getItem(PREFS_STORAGE_KEY) ?? 'null')).toMatchObject({
    model: 'claude-opus-5',
    effort: 'xhigh'
  });
  await waitFor(() => effortChip()?.textContent?.trim() === 'Extra high');
});

test('the reasoning slider draws one dot per level and the arrows move it', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  await waitFor(() => effortChip() !== null);

  query<HTMLButtonElement>('[data-testid=composer-effort]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-effort-menu]') !== null);
  // The echo model runs two levels, so the track carries two dots and its value
  // is the index of the one that is live.
  expect(effortDots()).toEqual(['low', 'high']);
  expect(query('[data-testid=effort-track]').getAttribute('aria-valuemax')).toBe('1');
  expect(query('[data-testid=effort-track]').getAttribute('aria-valuenow')).toBe('1');
  // The track takes the keyboard the moment the popover is there.
  await waitFor(() => document.activeElement === query('[data-testid=effort-track]'));

  const update = vi.spyOn(store, 'update');
  expect(press('ArrowLeft')).toBe(false);
  await waitFor(() => store.openThread?.effort === 'low');
  expect(update).toHaveBeenCalledWith('t-trace', { accountId: 'a-echo', model: 'echo-1', effort: 'low', speed: null, expectedSelectionVersion: 0 });
  await waitFor(() => query('[data-testid=effort-track]').getAttribute('aria-valuenow') === '0');
  expect(effortChip()?.textContent?.trim()).toBe('Low');

  // One dot right takes the same save path, and the popover stays open under it.
  press('ArrowRight');
  await waitFor(() => store.openThread?.effort === 'high');
  expect(update).toHaveBeenCalledWith('t-trace', { accountId: 'a-echo', model: 'echo-1', effort: 'high', speed: null, expectedSelectionVersion: 1 });
  expect(document.querySelector('[data-testid=composer-effort-menu]')).not.toBeNull();
  await waitFor(() => effortChip()?.textContent?.trim() === 'High');

  press('Home');
  await waitFor(() => query('[data-testid=effort-track]').getAttribute('aria-valuenow') === '0');
  press('End');
  await waitFor(() => query('[data-testid=effort-track]').getAttribute('aria-valuenow') === '1');
});

test('a model with no reasoning scale gets no chip at all', async () => {
  await mountOnFake();
  await openDraft();
  await waitFor(() => effortChip() !== null);

  // Claude Haiku 4.5 is the one legacy model the descriptor gives no levels.
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);
  query<HTMLButtonElement>('[data-testid=picker-legacy]').click();
  await waitFor(() => document.querySelector('[data-model="claude-haiku-4-5-20251001"]') !== null);
  query<HTMLButtonElement>('[data-model="claude-haiku-4-5-20251001"]').click();

  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') === null);
  await waitFor(() => effortChip() === null);
  expect(query('[data-testid=composer-picker]').textContent).toContain('Claude Haiku 4.5');
});

test('an install that already has conversations keeps every chip in the bar', async () => {
  await mountOnFake();
  // No record on this device, and the core has threads: the chips stay where they were.
  expect(work.current.pins).toEqual({ effort: true, worktree: true });
  expect(JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null')).toMatchObject({ pins: { effort: true, worktree: true }, panel: 'launcher' });
  await openDraft();
  await waitFor(() => effortChip() !== null);
  query('[data-testid=composer-worktree]');
  expect(input().placeholder).toBe('What do you want to do?');

  // The Options menu still lists them, their pins pressed.
  query<HTMLButtonElement>('[data-testid=composer-more]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-more-menu]') !== null);
  expect(query('[data-testid=composer-pin-effort]').getAttribute('aria-pressed')).toBe('true');
  expect(query('[data-testid=composer-pin-worktree]').getAttribute('aria-pressed')).toBe('true');
});

test('a first run keeps effort and worktree in Options until pinned, and a worktree turned on stays in view', async () => {
  window.localStorage.setItem(WORK_STORAGE_KEY, JSON.stringify(freshWork()));
  work.load();
  await mountOnFake();
  // The record on the device wins over the threads the core holds.
  expect(work.current.pins).toEqual({ effort: false, worktree: false });
  store.startDraft('p-boite');
  await waitFor(() => query('[data-testid=composer-picker]').textContent?.includes('Claude Opus 5') === true);
  expect(effortChip()).toBeNull();
  expect(document.querySelector('[data-testid=composer-worktree]')).toBeNull();
  // The permission mode is never hidden.
  query('[data-testid=composer-mode]');

  query<HTMLButtonElement>('[data-testid=composer-more]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-more-menu]') !== null);
  expect(query('[data-testid=composer-pin-effort]').getAttribute('aria-pressed')).toBe('false');

  // A worktree turned on is a choice away from the default: its chip shows, unpinned.
  query<HTMLButtonElement>('[data-testid=composer-options-worktree]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-worktree]') !== null);
  expect(work.current.pins.worktree).toBe(false);

  query<HTMLButtonElement>('[data-testid=composer-pin-effort]').click();
  await waitFor(() => effortChip() !== null);
  expect(JSON.parse(window.localStorage.getItem(WORK_STORAGE_KEY) ?? 'null').pins).toEqual({ effort: true, worktree: false });
});

test('the picker keeps row, account and legacy keyboard navigation separate', async () => {
  await mountOnFake();
  await openDraft();
  query<HTMLButtonElement>('[data-testid=composer-picker]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-picker-menu]') !== null);

  const claudeTile = query<HTMLButtonElement>('[data-provider=claude]');
  claudeTile.focus();
  expect(press('ArrowDown')).toBe(false);
  expect(document.activeElement).toBe(query('[data-provider=echo]'));

  const firstSeat = query<HTMLButtonElement>('[data-instance="claude::a-claude-main"]');
  const secondSeat = query<HTMLButtonElement>('[data-instance="claude::a-claude-side"]');
  firstSeat.focus();
  expect(press('ArrowRight')).toBe(false);
  expect(document.activeElement).toBe(secondSeat);
  expect(press('ArrowLeft')).toBe(false);
  expect(document.activeElement).toBe(firstSeat);

  const legacyRow = query<HTMLButtonElement>('[data-testid=picker-legacy]');
  legacyRow.focus();
  expect(press('ArrowRight')).toBe(false);
  await waitFor(() => document.activeElement?.closest('[data-testid=picker-legacy-menu]') !== null);
  expect(press('ArrowLeft')).toBe(false);
  expect(document.activeElement).toBe(legacyRow);
});

test('a refused turn keeps the prompt for Enter and Ctrl+Enter', async () => {
  await mountOnFake();
  await store.open('t-trace');
  const client = store.client!;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'turns.start') return Promise.reject(new Error('model refused'));
    return call(method, params);
  });
  for (const ctrlKey of [false, true]) {
    await type('keep my prompt');
    press('Enter', { ctrlKey });
    await waitFor(() => store.error === 'model refused');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input().value).toBe('keep my prompt');
    expect(store.openThread?.id).toBe('t-trace');
    expect(store.draft).toBeNull();
  }
});

test('reconnecting blocks keyboard and button sends without clearing text', async () => {
  await mountOnFake();
  await store.open('t-trace');
  const submit = vi.spyOn(store, 'submit');
  store.connection = 'connecting';
  await type('wait for connection');
  expect(query<HTMLButtonElement>('[data-testid=composer-send]').disabled).toBe(true);
  press('Enter');
  press('Enter', { ctrlKey: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(submit).not.toHaveBeenCalled();
  expect(input().value).toBe('wait for connection');
});

test('ArrowUp removes the latest queued prompt and restores its images for editing', async () => {
  await mountOnFake();
  await store.open('t-trace');
  store.openThread!.status = 'running';
  await type('first pending');
  press('Enter');
  await type('edit this pending prompt');
  const image = { kind: 'image' as const, mimeType: 'image/png' as const, data: 'aW1hZ2U=', name: 'draft.png' };
  store.composerStates['t-trace']!.attachments = [image];
  press('Enter');
  await waitFor(() => input().value === '');
  expect(document.querySelector('[data-testid=composer-queued]')?.textContent).toContain('edit this pending prompt');
  press('ArrowUp');
  await waitFor(() => input().value === 'edit this pending prompt');
  expect(store.composerStates['t-trace']!.queued.map((entry) => entry.text)).toEqual(['first pending']);
  expect(store.composerStates['t-trace']!.attachments).toEqual([image]);
  await type('edited pending prompt');
  press('Enter');
  await waitFor(() => input().value === '');
  expect(store.composerStates['t-trace']!.queued.map((entry) => entry.text)).toEqual(['first pending', 'edited pending prompt']);
});

test('Escape stops the running turn and sends pending input next', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await type('Wait for me [permission]');
  press('Enter');
  await waitFor(() => store.openThread?.status === 'waiting');
  await type('Read this immediately');
  press('Enter');
  await waitFor(() => input().value === '');
  press('Escape');
  await waitFor(() => !store.busy && store.composerStates['t-trace']?.queued.length === 0);
  const prompts = store.openThread!.messages.filter((message) => message.role === 'user');
  expect(prompts.at(-1)?.parts).toEqual([{ type: 'text', text: 'Read this immediately' }]);
  expect(store.openThread!.turns.some((turn) => turn.status === 'stopped')).toBe(true);
});

test('goal and loop coexist above the composer with expandable agent tasks', async () => {
  await mountOnFake();
  await store.open('t-trace');
  const call = vi.spyOn(store.client!, 'call');
  await type('/goal Finish the release');
  press('Enter');
  await waitFor(() => document.querySelector('[data-testid=activity-goal]') !== null);
  expect(call.mock.calls.some(([method, params]) => method === 'threads.activity.set' && 'goal' in params)).toBe(true);
  await store.stop();
  await waitFor(() => !store.busy);
  await type('/loop 5m Check CI');
  press('Enter');
  await waitFor(() => document.querySelector('[data-testid=activity-loop]') !== null);
  await store.stop();
  await waitFor(() => !store.busy);
  store.openThread!.activity!.tasks = [
    { id: '1', text: 'Run checks', status: 'completed' },
    { id: '2', text: 'Review the result', status: 'in_progress' }
  ];
  await waitFor(() => document.querySelector('[data-testid=activity-tasks-toggle]') !== null);
  const toggle = query<HTMLButtonElement>('[data-testid=activity-tasks-toggle]');
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  toggle.click();
  await waitFor(() => toggle.getAttribute('aria-expanded') === 'true');
  expect(query('[data-testid=activity-tasks]').textContent).toContain('Review the result');
  expect(query('[data-testid=thread-activity]').textContent).toContain('Finish the release');
  expect(query('[data-testid=activity-loop]').textContent).toContain('Iteration');
  expect(query('[data-testid=activity-loop] .objective').getAttribute('title')).toBe('Check CI');
});

test('queued prompts stay on their thread and run as separate turns', async () => {
  await mountOnFake();
  await store.open('t-trace');
  store.openThread!.status = 'running';
  await type('first queued prompt');
  press('Enter');
  await type('second queued prompt');
  press('Enter');
  await waitFor(() => input().value === '');
  await store.open('t-descriptors');
  await waitFor(() => store.openThread?.id === 't-descriptors');
  await store.open('t-trace');
  await waitFor(() => store.openThread!.messages.filter((m) => m.role === 'user').length === 3 && !store.busy);
  expect(store.openThread!.messages.filter((m) => m.role === 'user').slice(-2).map((m) => m.parts)).toEqual([
    [{ type: 'text', text: 'first queued prompt' }],
    [{ type: 'text', text: 'second queued prompt' }]
  ]);
  // Both prompts have run, on t-trace: anything sent to the other thread was sent before them.
  const other = await store.client!.call('threads.get', { threadId: 't-descriptors' });
  expect(other.messages.some((m) => m.parts.some((p) => p.type === 'text' && p.text.includes('queued prompt')))).toBe(false);
});



test('a draft keeps its prompt in the created thread when turns.start fails', async () => {
  await mountOnFake();
  store.startDraft();
  await waitFor(() => store.draft !== null);
  const client = store.client!;
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'turns.start') return Promise.reject(new Error('draft turn refused'));
    return call(method, params);
  });
  await type('the first prompt must survive');
  press('Enter');
  await waitFor(() => store.error === 'draft turn refused');
  expect(store.openThread?.title).toBe('the first prompt must survive');
  expect(input().value).toBe('the first prompt must survive');
});

test('a pending send cannot duplicate a turn or erase text typed for the next prompt', async () => {
  await mountOnFake();
  await store.open('t-trace');
  const client = store.client!;
  const call = client.call.bind(client);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rpc = vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'turns.start') await gate;
    return call(method, params);
  });
  await type('send this once');
  press('Enter');
  press('Enter');
  await type('still composing the next prompt');
  release();
  await waitFor(() => store.busy);
  expect(input().value).toBe('still composing the next prompt');
  expect(rpc.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(1);
});

// -- images -------------------------------------------------------------------

/** One transparent pixel, the smallest real PNG. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function pngFile(name = 'pixel.png'): File {
  const bytes = Uint8Array.from(atob(PIXEL), (character) => character.charCodeAt(0));
  return new File([bytes], name, { type: 'image/png' });
}

/**
 * jsdom builds neither `DataTransfer` nor `ClipboardEvent`, so the paste lands
 * as a plain event carrying the same `clipboardData` shape the handler reads.
 */
function paste(file: File): void {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] }
  });
  input().dispatchEvent(event);
}

function chips(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid=composer-attachment]'));
}

test('a pasted image becomes a chip, comes off again, and rides the prompt', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  // The echo agent reads images, so the chip bar offers the paperclip.
  await waitFor(() => document.querySelector('[data-testid=composer-attach]') !== null);

  paste(pngFile());
  await waitFor(() => chips().length === 1);
  expect(chips()[0]?.getAttribute('title')).toBe('pixel.png');
  expect(query<HTMLImageElement>('[data-testid=composer-attachment] img').getAttribute('src')).toBe(
    `data:image/png;base64,${PIXEL}`
  );

  query<HTMLButtonElement>('[data-testid=composer-attachment-remove]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-attachments]') === null);

  paste(pngFile());
  await waitFor(() => chips().length === 1);
  await type('look at this');
  input().focus();
  press('Enter');
  await waitFor(() => (store.openThread?.messages.length ?? 0) >= 4 && !store.busy);

  const sent = store.openThread!.messages.filter((m) => m.role === 'user').at(-1)!;
  expect(sent.parts[0]).toEqual({ type: 'text', text: 'look at this' });
  expect(sent.parts[1]).toEqual({
    type: 'image',
    mimeType: 'image/png',
    data: PIXEL,
    alt: 'pixel.png'
  });
  // The timeline draws it under the text of that bubble.
  await waitFor(() => document.querySelectorAll('[data-testid=image-part]').length === 1);

  const answer = store
    .openThread!.messages.at(-1)!
    .parts.filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
  expect(answer.startsWith('[image image/png, 70 bytes, pixel.png] ')).toBe(true);
  expect(answer.endsWith('look at this')).toBe(true);

  // What went out left the composer, text and picture together.
  expect(input().value).toBe('');
  expect(document.querySelector('[data-testid=composer-attachments]')).toBeNull();
});

test('sending waits for a file read so the attachment cannot land in the next prompt', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await type('Read these notes');
  const original = FileReader.prototype.readAsDataURL;
  let release!: () => void;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob: Blob) {
    release = () => original.call(this, blob);
  });
  paste(new File(['notes'], 'notes.txt', { type: 'text/plain' }));
  await waitFor(() => query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  const before = store.openThread!.messages.length;
  press('Enter');
  expect(store.openThread!.messages.length).toBe(before);
  release();
  await waitFor(() => !query<HTMLButtonElement>('[data-testid=composer-send]').disabled);
  press('Enter');
  await waitFor(() => store.openThread!.messages.length > before && !store.busy);
  const sent = store.openThread!.messages.filter(m => m.role === 'user').at(-1)!;
  expect(sent.parts).toContainEqual({ type: 'file', mimeType: 'text/plain', name: 'notes.txt', data: btoa('notes') });
});

test('a file read uses the original provider even if the user switches threads', async () => {
  window.localStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify({ ...defaultPrefs(), providerId: 'opencode', accountId: 'a-opencode', model: 'default' }));
  await mountOnFake();
  store.startDraft();
  await waitFor(() => store.draft !== null && store.defaultChoice()?.providerId === 'opencode');
  const original = FileReader.prototype.readAsDataURL;
  let release!: () => void;
  vi.spyOn(FileReader.prototype, 'readAsDataURL').mockImplementation(function (this: FileReader, blob: Blob) {
    release = () => original.call(this, blob);
  });
  paste(pngFile());
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace');
  release();
  await waitFor(() => store.error !== null);
  expect(store.error).toBe('OpenCode takes no images: send the prompt without them.');
  expect(Object.values(store.composerStates).every(state => state.attachments.length === 0)).toBe(true);
});

test('a provider that reads no image still takes files and refuses an image paste', async () => {
  window.localStorage.setItem(
    PREFS_STORAGE_KEY,
    JSON.stringify({ ...defaultPrefs(), providerId: 'opencode', accountId: 'a-opencode', model: 'default' })
  );
  await mountOnFake();
  store.startDraft();
  await waitFor(() => store.draft !== null);
  await waitFor(() => store.defaultChoice()?.providerId === 'opencode');

  expect(document.querySelector('[data-testid=composer-attach]')).not.toBeNull();

  paste(pngFile());
  await waitFor(() => store.error !== null);
  expect(store.error).toBe('OpenCode takes no images: send the prompt without them.');
  expect(document.querySelector('[data-testid=composer-attachments]')).toBeNull();
  paste(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  await waitFor(() => document.querySelector('[data-testid=composer-attachment]') !== null);
  expect(query('[data-testid=composer-attachment]').textContent).toContain('notes.txt');
});

// -- the slash menu -----------------------------------------------------------

function slashRows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid=slash-row]')).map(
    (row) => row.getAttribute('data-name') ?? ''
  );
}

function slashMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid=slash-menu]');
}

test('recognized slash tokens are colored without changing the editable prompt', async () => {
  await mountOnFake();
  for (const prompt of ['/goal', '/loop 2 repeat this', '/shout hello\nnext line', '/model']) {
    await type(prompt);
    const highlight = query('[data-testid=composer-highlight]');
    expect(highlight.getAttribute('aria-hidden')).toBe('true');
    expect(highlight.querySelector('.command-token')?.textContent).toBe(prompt.split(/\s/)[0]);
    expect(highlight.textContent).toBe(`${prompt}\n`);
    expect(input().value).toBe(prompt);
    expect(input().classList.contains('highlighted')).toBe(true);
  }
  input().scrollTop = 45;
  input().dispatchEvent(new Event('scroll'));
  await waitFor(() => query('.input-paint').style.transform === 'translateY(-45px)');
  for (const prompt of ['/loo', '/unknown words', 'mention /goal here', '']) {
    await type(prompt);
    expect(document.querySelector('[data-testid=composer-highlight]')).toBeNull();
    expect(input().classList.contains('highlighted')).toBe(false);
  }
});

test('permission menu offers three policies and preserves legacy modes until picked', async () => {
  await mountOnFake();
  await waitFor(() => !store.busy);
  for (const legacy of ['plan', 'dontAsk'] as const) {
    store.openThread!.permissionMode = legacy;
    await waitFor(() => query('[data-testid=composer-mode]').textContent?.trim() === (legacy === 'plan' ? 'Plan' : 'Auto-deny'));
    expect(store.openThread?.permissionMode).toBe(legacy);
  }
  query('[data-testid=composer-mode]').click();
  await waitFor(() => document.querySelector('[data-testid=composer-mode-menu]') !== null);
  const menu = query('[data-testid=composer-mode-menu]');
  expect(Array.from(menu.querySelectorAll('.label')).map(row => row.textContent?.trim())).toEqual(['No confirmation', 'Edit freely', 'Ask']);
  for (const [mode, label] of [['bypassPermissions', 'No confirmation'], ['acceptEdits', 'Edit freely'], ['default', 'Ask']]) {
    query(`[data-testid=composer-mode-menu] [data-value="${mode}"]`).click();
    await waitFor(() => store.openThread?.permissionMode === mode);
    expect(query('[data-testid=composer-mode]').textContent?.trim()).toBe(label);
    await new Promise(resolve => setTimeout(resolve, 180));
    query('[data-testid=composer-mode]').click();
    await waitFor(() => document.querySelector('[data-testid=composer-mode-menu]') !== null);
  }
});

test('a slash lists the agent commands first, filters, and completes the box', async () => {
  await mountOnFake();
  // The thread a boot opens has already run a turn, so the echo agent has
  // already said what it takes.
  await waitFor(() => store.openThread?.id === 't-descriptors' && !store.busy);
  expect(store.openThread?.commands.map((command) => command.name)).toEqual(['shout', 'whisper']);

  await type('/');
  await waitFor(() => slashMenu() !== null);
  const rows = slashRows();
  // The agent's two, in its own order, before every one of Boite's.
  expect(rows.slice(0, 2)).toEqual(['shout', 'whisper']);
  expect(rows).toContain('model');
  expect(rows).toContain('theme-dark');
  expect(slashMenu()?.textContent).toContain('The prompt back in capitals');
  expect(slashMenu()?.textContent).toContain('<text>');
  expect(document.body.textContent).toContain('Agent');
  expect(document.body.textContent).toContain('Boite');

  await type('/sho');
  await waitFor(() => slashRows().length === 1);
  expect(slashRows()).toEqual(['shout']);

  // Enter takes the row the keyboard is on: the box completes, the menu goes.
  input().focus();
  expect(press('Enter')).toBe(false);
  await waitFor(() => slashMenu() === null);
  expect(input().value).toBe('/shout ');

  // The completed command is a plain prompt, and the fake echoes it in capitals.
  await type('/shout hello');
  input().focus();
  press('Enter');
  await waitFor(() => (store.openThread?.messages.length ?? 0) >= 4 && !store.busy);
  const answer = store
    .openThread!.messages.at(-1)!
    .parts.filter((part) => part.type === 'text')
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('');
  expect(answer).toBe('HELLO');
});

test('one of Boite own commands runs from the slash menu and empties the box', async () => {
  await mountOnFake();
  await waitFor(() => store.openThread !== null && !store.busy);

  await type('/dark');
  await waitFor(() => slashMenu() !== null);
  expect(slashRows()).toEqual(['theme-dark']);

  input().focus();
  expect(press('Enter')).toBe(false);
  await waitFor(() => slashMenu() === null);
  expect(input().value).toBe('');
  expect(window.localStorage.getItem('boite.theme')).toBe('dark');
  // Nothing was sent: a Boite command is not a prompt.
  expect(store.busy).toBe(false);
});

// -- the mention menu ---------------------------------------------------------

function mentionRows(): string[] {
  return Array.from(document.querySelectorAll('[data-testid=mention-row]')).map(
    (row) => row.getAttribute('data-name') ?? ''
  );
}

function mentionMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid=mention-menu]');
}

test('an at sign lists the project files, narrows on the word, and writes the pick in as a path', async () => {
  await mountOnFake();
  await waitFor(() => store.openThread !== null && !store.busy);

  // Anywhere in the text, not only at the start: the word under the caret is the query.
  await type('please read @');
  await waitFor(() => mentionMenu() !== null && mentionRows().length > 0);
  expect(mentionRows()).toContain('src/lib/store.svelte.ts');
  expect(mentionMenu()?.textContent).toContain('store.svelte.ts');
  expect(mentionMenu()?.textContent).toContain('src/lib');
  // The slash menu stays shut: `@` is not `/`.
  expect(slashMenu()).toBeNull();

  await type('please read @stri');
  await waitFor(() => mentionRows().length === 1);
  expect(mentionRows()).toEqual(['src/lib/strings.ts']);

  input().focus();
  expect(press('Enter')).toBe(false);
  await waitFor(() => mentionMenu() === null);
  expect(input().value).toBe('please read @src/lib/strings.ts ');
  // Nothing was sent: the pick completes the text, the user goes on.
  expect(store.busy).toBe(false);

  // A second mention further along ranks on its own word, and the first one stands.
  await type('please read @src/lib/strings.ts and @composer');
  await waitFor(() => mentionRows()[0] === 'src/components/Composer.svelte');
  expect(mentionRows()).toEqual(['src/components/Composer.svelte']);
  input().focus();
  expect(press('Tab')).toBe(false);
  await waitFor(() => mentionMenu() === null);
  expect(input().value).toBe('please read @src/lib/strings.ts and @src/components/Composer.svelte ');
});

test('Escape shuts the mention menu, a space closes it, and nothing matches says so', async () => {
  await mountOnFake();
  await waitFor(() => store.openThread !== null && !store.busy);

  await type('@');
  await waitFor(() => mentionMenu() !== null);
  input().focus();
  expect(press('Escape')).toBe(false);
  await waitFor(() => mentionMenu() === null);
  expect(input().value).toBe('@');

  await type('@nothing-here');
  await waitFor(() => document.querySelector('[data-testid=mention-empty]') !== null);
  expect(mentionRows()).toEqual([]);

  // Enter with nothing to pick is the send, as always.
  await type('@main ');
  await waitFor(() => mentionMenu() === null);
});

test('Escape shuts the slash menu and keeps what is typed', async () => {
  await mountOnFake();
  await waitFor(() => store.openThread !== null && !store.busy);

  await type('/');
  await waitFor(() => slashMenu() !== null);

  input().focus();
  expect(press('Escape')).toBe(false);
  await waitFor(() => slashMenu() === null);
  expect(input().value).toBe('/');

  // It stays shut on that text, and the next keystroke opens it again.
  press('ArrowDown');
  expect(slashMenu()).toBeNull();
  await type('/wh');
  await waitFor(() => slashMenu() !== null);
  expect(slashRows()).toEqual(['whisper']);

  // Tab picks what Enter picks.
  input().focus();
  expect(press('Tab')).toBe(false);
  await waitFor(() => slashMenu() === null);
  expect(input().value).toBe('/whisper ');
});

test('queued prompts survive settings and wait for a ready connection', async () => {
  await mountOnFake();
  await store.open('t-trace');
  store.openThread!.status = 'running';
  await type('queue through settings');
  press('Enter');
  await waitFor(() => input().value === '');
  store.page = 'settings';
  await waitFor(() => document.querySelector('[data-testid=composer-input]') === null);
  store.connection = 'connecting';
  store.openThread!.status = 'idle';
  store.page = 'chat';
  await waitFor(() => document.querySelector('[data-testid=composer-queued]') !== null);
  const rpc = vi.spyOn(store.client!, 'call');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(rpc.mock.calls.filter(([method]) => method === 'turns.start')).toHaveLength(0);
  store.connection = 'ready';
  await waitFor(() => store.busy);
  expect(rpc.mock.calls.filter(([method]) => method === 'turns.start')).toEqual([
    ['turns.start', { threadId: 't-trace', prompt: 'queue through settings', expectedSelectionVersion: 0, clientRequestId: expect.stringMatching(/^[a-f0-9]{32}$/) }]
  ]);
});

test('a refused prompt keeps its place in the queue and the next send resumes it in order', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  const client = store.client!;
  const call = client.call.bind(client);
  let refuse = true;
  vi.spyOn(client, 'call').mockImplementation((method, params) => {
    if (method === 'turns.start' && refuse) return Promise.reject(new Error('account at its cap'));
    return call(method, params);
  });

  // Two prompts queued behind a running turn, a third typed while it runs.
  store.openThread!.status = 'running';
  await type('P1');
  press('Enter');
  await type('P2');
  press('Enter');
  await waitFor(() => input().value === '');
  await type('P3');

  // The turn ends, the queue drains, and the core refuses the first prompt.
  store.openThread!.status = 'idle';
  await waitFor(() => store.error === 'account at its cap');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(store.composerStates['t-trace']?.queued.map((entry) => entry.text)).toEqual(['P1', 'P2']);
  expect(input().value).toBe('P3');

  // Sending the third is the explicit retry: it goes in behind what waits.
  refuse = false;
  input().focus();
  press('Enter');
  await waitFor(() => (store.composerStates['t-trace']?.queued.length ?? 1) === 0 && !store.busy);

  const sent = store
    .openThread!.messages.filter((message) => message.role === 'user')
    .slice(-3)
    .map((message) => message.parts.map((part) => (part.type === 'text' ? part.text : '')).join(''));
  expect(sent).toEqual(['P1', 'P2', 'P3']);
});

test('the mention menu never opens on the project the composer just left', async () => {
  await mountOnFake();
  await store.open('t-trace');
  await waitFor(() => store.openThread?.id === 't-trace' && !store.busy);
  const client = store.client!;
  const call = client.call.bind(client);
  // The fake ranks one list for every project, so each gets its own here: what
  // is on the screen has to name the project the composer is standing in.
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method !== 'projects.files') return call(method, params);
    return { files: [`${(params as { projectId: string }).projectId}/one.ts`], total: 1, capped: false };
  });

  await type('read @o');
  await waitFor(() => mentionRows().length === 1);
  expect(mentionRows()).toEqual(['p-boite/one.ts']);

  await store.open('t-descriptors');
  await waitFor(() => store.openThread?.id === 't-descriptors');
  await type('read @o');

  // The frame it opens on holds nothing of the project just left.
  expect(mentionRows()).toEqual([]);
  await waitFor(() => mentionRows().length === 1);
  expect(mentionRows()).toEqual(['p-notes/one.ts']);
});
