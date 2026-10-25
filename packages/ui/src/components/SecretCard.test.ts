import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { MessagePart } from '@boite/contracts';
import { FakeClient, type FakeClientOptions } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { replyTarget } from '../lib/question-reply.svelte';
import AssistantMessage from './AssistantMessage.svelte';
import ThreadActivity from './ThreadActivity.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let dock: ReturnType<typeof mount> | undefined;
const closers: (() => void)[] = [];

afterEach(async () => {
  if (mounted) await unmount(mounted);
  if (dock) await unmount(dock);
  mounted = undefined;
  dock = undefined;
  for (const close of closers.splice(0)) close();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) { await tick(); await Promise.resolve(); }
  flushSync();
}

function query<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`no ${selector}`);
  return node;
}

const SECRET = 'sk-test-0123456789abcdef';

/** A card asked on the seeded thread, drawn the way the timeline draws it. */
async function asked(options: FakeClientOptions = {}, ask: { replace?: boolean; placeholder?: string; requestId?: string } = {}) {
  const client = new FakeClient({ delayMs: 0, ...options });
  const store = new Store();
  store.attach(client);
  closers.push(() => { store.detach(); client.close(); });
  await store.connect();
  await store.open('t-trace');
  const outcome = client.call('secrets.ask', { threadId: 't-trace', name: 'OPENAI_API_KEY', reason: 'To call the embeddings API.', ...ask });
  // Closing the client drops a card still open; that rejection is the teardown's, not the test's.
  outcome.catch(() => undefined);
  await settle();
  const message = store.openThread!.messages.find((entry) => entry.parts[0]?.type === 'secret_request');
  if (!message) throw new Error('the card was not drawn');
  mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: 't-trace', message, signedOut: null, showModel: false } });
  dock = mount(ThreadActivity, { target: document.body, props: { store } });
  await settle();
  return { store, client, outcome, part: () => message.parts[0] as Extract<MessagePart, { type: 'secret_request' }> };
}

function type(value: string): HTMLInputElement {
  const field = query<HTMLInputElement>('[data-testid=secret-field]');
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  return field;
}

test('a kept key is saved from Enter, the card folds to one line and nothing holds the value', async () => {
  const { store, client, outcome, part } = await asked({}, { placeholder: 'sk-...' });
  const field = query<HTMLInputElement>('[data-testid=secret-field]');
  expect(query('[data-testid=secret-name]').textContent).toBe('OPENAI_API_KEY');
  expect(query('[data-testid=secret-reason]').textContent).toBe('To call the embeddings API.');
  expect(field.type).toBe('text');
  expect(field.placeholder).toBe('sk-...');
  expect([field.autocomplete, field.getAttribute('data-lpignore'), field.getAttribute('data-form-type')]).toEqual(['off', 'true', 'other']);
  expect(field.hasAttribute('data-1p-ignore') && field.hasAttribute('data-bwignore')).toBe(true);
  const keep = query<HTMLInputElement>('[data-testid=secret-keep]');
  expect(keep.checked).toBe(false);
  expect(document.querySelector('[data-testid=secret-replaces]')).toBeNull();

  keep.click();
  type(SECRET);
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  flushSync();
  // Cleared the moment it is sent, before the core answers.
  expect(field.value).toBe('');
  await settle();

  expect(await outcome).toMatchObject({ outcome: 'saved', ref: 'secret:project/OPENAI_API_KEY' });
  await settle();
  const card = query('[data-testid=secret-card]');
  expect([card.getAttribute('data-state'), card.getAttribute('data-kept')]).toEqual(['saved', 'true']);
  expect(query('[data-testid=secret-outcome]').textContent).toBe('OPENAI_API_KEY saved and kept for this project');
  expect(document.querySelector('[data-testid=secret-field]')).toBeNull();
  expect(part()).toMatchObject({ status: 'saved', kept: true });

  const listed = await client.call('secrets.list', { projectId: 'p-boite' });
  expect(listed.secrets.map((key) => key.name)).toEqual(['OPENAI_API_KEY']);
  for (const held of [listed, store.openThread, document.body.innerHTML]) expect(JSON.stringify(held)).not.toContain(SECRET);
});

test('typing, pasting and Escape in the field reach no window or document listener', async () => {
  const { store } = await asked();
  const heard: string[] = [];
  const listen = (event: Event) => heard.push(`${event.type}:${(event as KeyboardEvent).key ?? ''}`);
  const types = ['keydown', 'keypress', 'keyup', 'paste', 'input'];
  for (const name of types) { window.addEventListener(name, listen); document.addEventListener(name, listen); }
  try {
    const field = query<HTMLInputElement>('[data-testid=secret-field]');
    for (const key of ['s', 'k', 'Escape']) {
      field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      field.dispatchEvent(new KeyboardEvent('keypress', { key, bubbles: true, cancelable: true }));
      field.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    }
    field.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }));
    type(SECRET);
    expect(heard).toEqual([]);
    // Escape stopped nothing and closed nothing: the card still waits, holding what was typed.
    expect(query('[data-testid=secret-card]').getAttribute('data-state')).toBe('pending');
    expect(field.value).toBe(SECRET);
    expect(store.openThread?.status).not.toBe('stopping');
  } finally {
    for (const name of types) { window.removeEventListener(name, listen); document.removeEventListener(name, listen); }
  }
});

test('a card replacing the kept key says so and starts ticked; unticked, it saves a one-off copy', async () => {
  const { outcome } = await asked({}, { replace: true });
  expect(query('[data-testid=secret-replaces]').textContent).toBe('Replaces the key kept for this project.');
  const keep = query<HTMLInputElement>('[data-testid=secret-keep]');
  expect(keep.checked).toBe(true);
  keep.click();
  type(SECRET);
  query<HTMLButtonElement>('[data-testid=secret-save]').click();
  expect((await outcome).ref).toMatch(/^secret:sec_/);
  await settle();
  expect(query('[data-testid=secret-outcome]').textContent).toBe('OPENAI_API_KEY saved for this conversation');
  expect(query('[data-testid=secret-card]').hasAttribute('data-kept')).toBe(false);
});

test('over a link nobody encrypts the field and Save are off, Decline still answers, and a retry with the id gets the same card', async () => {
  const { store, client, outcome } = await asked({ plainLink: true }, { requestId: 'sreq-retry' });
  const retry = () => client.call('secrets.ask', { threadId: 't-trace', name: 'OPENAI_API_KEY', reason: 'To call the embeddings API.', requestId: 'sreq-retry' });
  const again = retry();
  await settle();
  expect(store.openThread!.messages.filter((entry) => entry.parts[0]?.type === 'secret_request')).toHaveLength(1);
  expect(query('[data-testid=secret-plain]').textContent).toBe('Answer from the PC or over HTTPS');
  expect(query<HTMLInputElement>('[data-testid=secret-field]').disabled).toBe(true);
  expect(query<HTMLButtonElement>('[data-testid=secret-save]').disabled).toBe(true);
  query<HTMLButtonElement>('[data-testid=secret-decline]').click();
  expect(await outcome).toMatchObject({ outcome: 'declined', ref: null });
  expect(await again).toEqual(await outcome);
  expect(await retry()).toEqual(await outcome);
  await settle();
  expect(query('[data-testid=secret-card]').getAttribute('data-state')).toBe('declined');
  expect(query('[data-testid=secret-outcome]').textContent).toBe('OPENAI_API_KEY declined');
});

test('a pending secret stays in the question dock and leaves only a link in the timeline', async () => {
  await asked();
  const field = query('[data-testid=secret-field]');
  expect(field.closest('[data-testid=thread-activity]')).not.toBeNull();
  expect(document.querySelectorAll('[data-testid=secret-field]')).toHaveLength(1);
  expect(query('[data-testid=secret-docked]').querySelector('input')).toBeNull();
});

test.each([false, true])('new requests keep the current secret, input and storage choice (replace=%s); the timeline link reopens its place in the pager', async (replace) => {
  const { client, store, part } = await asked({}, { replace });
  type(SECRET);
  const keep = query<HTMLInputElement>('[data-testid=secret-keep]');
  expect(keep.checked).toBe(replace);
  keep.click();
  await settle();
  expect(keep.checked).toBe(!replace);
  const second = client.call('secrets.ask', { threadId: 't-trace', name: 'DEPLOY_TOKEN', reason: 'Deploy the preview.' });
  second.catch(() => undefined);
  await settle();
  expect(query<HTMLInputElement>('[data-testid=activity-question]:not([hidden]) [data-testid=secret-field]').value).toBe(SECRET);
  expect(keep.checked).toBe(!replace);
  expect(query('[data-testid=activity-question-index]').textContent).toBe('1 of 2');
  query<HTMLButtonElement>('[data-testid=activity-question-next]').click();
  await settle();
  expect(query('[data-testid=activity-question]:not([hidden]) [data-testid=secret-reason]').textContent).toBe('Deploy the preview.');
  expect(query<HTMLInputElement>('[data-testid=activity-question]:not([hidden]) [data-testid=secret-field]').value).toBe('');
  expect(query<HTMLInputElement>('[data-testid=activity-question]:not([hidden]) [data-testid=secret-keep]').checked).toBe(false);
  query<HTMLButtonElement>('[data-testid=activity-question-toggle]').click();
  await settle();
  query<HTMLButtonElement>('[data-testid=secret-docked]').click();
  await settle();
  expect(query('[data-testid=activity-question-toggle]').getAttribute('aria-expanded')).toBe('true');
  expect(query('[data-testid=activity-question]:not([hidden])').getAttribute('data-question')).toBe(part().requestId);
  expect(query<HTMLInputElement>('[data-testid=activity-question]:not([hidden]) [data-testid=secret-field]').value).toBe(SECRET);
  expect(keep.checked).toBe(!replace);
  expect(JSON.stringify(store.composerStates)).not.toContain(SECRET);
});

test('a refused answer shows the core\'s message and leaves the field empty', async () => {
  const { client } = await asked();
  const real = client.call.bind(client);
  client.call = ((method: string, params: unknown) => method === 'secrets.answer'
    ? Promise.reject(new Error('the windows vault did not store the value'))
    : real(method as never, params as never)) as typeof client.call;
  const field = type(SECRET);
  query<HTMLButtonElement>('[data-testid=secret-save]').click();
  flushSync();
  expect(field.value).toBe('');
  await settle();
  expect(query('[data-testid=secret-error]').textContent).toContain('the windows vault did not store the value');
  expect(query('[data-testid=secret-card]').getAttribute('data-state')).toBe('pending');
});

test('a visible secret keeps the composer from answering a different hidden question', async () => {
  const { store } = await asked();
  store.pendingQuestions = [{ id: 'hidden-question', threadId: 't-trace', turnId: 'turn', text: 'Choose the next action', options: [], allowText: true, multiple: false, async: true, createdAt: Date.now() + 1000 }];
  await settle();
  expect(query('[data-testid=activity-question]:not([hidden]) [data-testid=secret-field]')).toBeTruthy();
  expect(replyTarget(store)).toBeNull();
  query<HTMLButtonElement>('[data-testid=activity-question-next]').click();
  await settle();
  expect(replyTarget(store)?.id).toBe('hidden-question');
});
