import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ContextControl from './ContextControl.svelte';
import { strings } from '../lib/strings';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});
const control = () => document.querySelector<HTMLButtonElement>('[data-testid="context-compact"]')!;
function open() {
  document.querySelector<HTMLButtonElement>('[data-testid="context-trigger"]')!.click();
  flushSync();
}

test('the core can disable a locally supported control and no action escapes a pending capability read', async ({ ready }) => {
  const { store, client } = await ready();
  await store.open('t-trace');
  store.openThread!.sessionId = 'session';
  const capabilities = await client.call('threads.capabilities', { threadId: 't-trace' });
  let release!: (value: typeof capabilities) => void;
  vi.spyOn(store, 'threadCapabilities').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const compact = vi.spyOn(store, 'compact').mockResolvedValue(undefined);
  view = mount(ContextControl, { target: document.body, props: { store } });
  flushSync(); open();
  expect(control().disabled).toBe(true);
  control().click();
  expect(compact).not.toHaveBeenCalled();
  release({ ...capabilities, compaction: { supported: true, available: false, reason: 'provider-unavailable' } });
  await vi.waitFor(() => expect(control().title).toBe(strings.composer.compactUnavailable));
  expect(control().disabled).toBe(true);
  expect(compact).not.toHaveBeenCalled();
});

test('capability errors fail closed, while an older core keeps the existing local fallback', async ({ ready }) => {
  const { store } = await ready();
  await store.open('t-trace');
  store.openThread!.sessionId = 'session';
  const read = vi.spyOn(store, 'threadCapabilities').mockRejectedValue(new Error('lost connection'));
  view = mount(ContextControl, { target: document.body, props: { store } });
  flushSync(); open();
  await vi.waitFor(() => expect(control().title).toBe(strings.composer.compactUnavailable));
  expect(control().disabled).toBe(true);
  read.mockResolvedValue(null);
  store.openThread!.selectionVersion = (store.openThread!.selectionVersion ?? 0) + 1;
  flushSync();
  await vi.waitFor(() => expect(control().disabled).toBe(false));
  store.connection = 'closed'; flushSync();
  expect(control().disabled).toBe(true);
});

test('a late capability reply cannot enable the next thread control', async ({ ready }) => {
  const { store, client } = await ready();
  await store.open('t-trace');
  store.openThread!.sessionId = 'first';
  const available = await client.call('threads.capabilities', { threadId: 't-trace' });
  let release!: (value: typeof available) => void;
  vi.spyOn(store, 'threadCapabilities').mockImplementation(id => id === 't-trace'
    ? new Promise(resolve => { release = resolve; })
    : Promise.resolve({ ...available, threadId: id, compaction: { supported: false, available: false, reason: 'unsupported' } }));
  view = mount(ContextControl, { target: document.body, props: { store } });
  flushSync(); open();
  await store.open('t-descriptors');
  store.openThread!.sessionId = 'second'; flushSync();
  await vi.waitFor(() => expect(control().title).toBe(strings.composer.compactUnavailable));
  release({ ...available, compaction: { supported: true, available: true, reason: null } });
  await Promise.resolve(); flushSync();
  expect(control().disabled).toBe(true);
});
