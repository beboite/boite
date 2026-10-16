import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../test/fake-client';
import ThreadRetry from './ThreadRetry.svelte';

let view: ReturnType<typeof mount> | undefined;
afterEach(() => {
  vi.useRealTimers();
  if (view) unmount(view, { outro: false });
  view = undefined;
  document.body.replaceChildren();
});

test('a capacity retry counts down to its next try and Stop retrying cancels it once', async ({ ready }) => {
  const { store, client } = await ready();
  await store.open('t-trace');
  const turnId = store.openThread!.turns.at(-1)!.id;
  client.planRetry('t-trace', { kind: 'capacity', turnId, at: Date.now() + 90_000, attempt: 2, attempts: 3, resetsAt: null });
  await vi.waitFor(() => expect(store.openThread?.retry?.kind).toBe('capacity'));
  view = mount(ThreadRetry, { target: document.body, props: { store } });
  flushSync();
  const banner = document.querySelector('[data-testid="thread-retry"]')!;
  expect(banner.textContent).toContain('Model at capacity');
  expect(banner.textContent).toMatch(/Trying again in 1m (29|30)s, try 2 of 3\./);
  const spy = vi.spyOn(client, 'call');
  const cancel = document.querySelector<HTMLButtonElement>('[data-testid="thread-retry-cancel"]')!;
  cancel.click();
  cancel.click();
  await vi.waitFor(() => expect(store.openThread?.retry ?? null).toBeNull());
  expect(spy.mock.calls.filter(([method]) => method === 'turns.cancelRetry')).toHaveLength(1);
  flushSync();
  expect(document.querySelector('[data-testid="thread-retry"]')).toBeNull();
});

test('a usage limit resume names the time it resumes at, and a paired phone can cancel it', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, principal: 'session' });
  await store.open('t-trace');
  const turnId = store.openThread!.turns.at(-1)!.id;
  const at = Date.now() + 2 * 3_600_000;
  client.planRetry('t-trace', { kind: 'usage-limit', turnId, at, attempt: 1, attempts: 1, resetsAt: at - 60_000 });
  await vi.waitFor(() => expect(store.openThread?.retry?.kind).toBe('usage-limit'));
  view = mount(ThreadRetry, { target: document.body, props: { store } });
  flushSync();
  const banner = document.querySelector('[data-testid="thread-retry"]')!;
  expect(banner.textContent).toContain('Usage limit reached');
  expect(banner.textContent).toMatch(/Resumes at .+, once the limit has reset, in 1h 59m\./);
  document.querySelector<HTMLButtonElement>('[data-testid="thread-retry-cancel"]')!.click();
  await vi.waitFor(() => expect(store.openThread?.retry ?? null).toBeNull());
});
