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

test('the meter follows the automatic compaction threshold and keeps a smaller model window', async ({ ready }) => {
  const { store } = await ready();
  await store.open('t-trace');
  store.openThread!.context = { tokens: 212_569, window: 1_000_000, at: 0,
    breakdown: { input: 150_000, cache: 50_000, output: 12_569 } };
  store.settings = { ...store.settings!, autoCompact: { tokens: 250_000, moments: ['turn-end'] } };
  view = mount(ContextControl, { target: document.body, props: { store } });
  flushSync(); open();
  const meter = () => document.querySelector<HTMLElement>('[data-testid="context-meter"]')!;
  const popup = () => document.querySelector<HTMLElement>('[data-testid="context-popup"]')!;
  const exact = (n: number) => n.toLocaleString();
  expect(meter().dataset.percent).toBe('85');
  expect(meter().dataset.level).toBe('high');
  expect(popup().querySelector('.total .mono')!.textContent).toBe(`${exact(212_569)} / ${exact(250_000)}`);
  expect(popup().querySelector('[data-testid="context-remaining"]')!.textContent).toBe(`${exact(37_431)} tokens before auto-compaction`);
  expect(popup().querySelector<HTMLElement>('.bar .input')!.style.width).toBe('60%');
  const info = popup().querySelector<HTMLButtonElement>('[data-testid="context-info"]')!;
  const detail = document.getElementById(info.getAttribute('aria-controls')!)!;
  expect(info.getAttribute('aria-expanded')).toBe('false');
  expect(detail.hidden).toBe(true);
  info.click(); flushSync();
  expect(info.getAttribute('aria-expanded')).toBe('true');
  expect(detail.hidden).toBe(false);
  expect(detail.querySelector('dl')!.textContent).toContain(exact(150_000));
  expect(popup().querySelector('[data-testid="context-auto-compact"]')!.textContent).toBe('Auto-compaction threshold. The model supports ' + exact(1_000_000) + ' tokens.');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); flushSync();
  expect(detail.hidden).toBe(true);
  expect(info.getAttribute('aria-expanded')).toBe('false');
  expect(popup()).not.toBeNull();

  for (const [window, threshold, percent, limit, notice] of [
    [128_000, 250_000, '100', 128_000, false],
    [250_000, 250_000, '85', 250_000, false],
    [1_000_000, null, '21', 1_000_000, false],
    [null, 250_000, '85', 250_000, true],
    [0, 250_000, '85', 250_000, true],
    [-1, 250_000, '85', 250_000, true],
  ] as const) {
    store.openThread!.context = { ...store.openThread!.context!, window };
    store.settings = { ...store.settings!, autoCompact: { tokens: threshold, moments: ['turn-end'] } };
    flushSync();
    expect(meter().dataset.percent).toBe(percent);
    expect(popup().querySelector('.total .mono')!.textContent).toBe(`${exact(212_569)} / ${exact(limit)}`);
    expect(popup().querySelector('[data-testid="context-remaining"]')!.textContent).toBe(notice
      ? strings.thread.contextRemainingCompact(exact(Math.max(0, limit - 212_569)))
      : strings.thread.contextRemaining(exact(Math.max(0, limit - 212_569))));
    expect(!!popup().querySelector('[data-testid="context-auto-compact"]')).toBe(notice);
    if (notice) expect(popup().querySelector('[data-testid="context-auto-compact"]')!.textContent).toBe('Auto-compaction threshold.');
  }
  store.settings = { ...store.settings!, autoCompact: null };
  flushSync();
  expect(meter().dataset.percent).toBe('');
  expect(popup().querySelector('.total .mono')!.textContent).toBe(exact(212_569));
  expect(popup().querySelector('[data-testid="context-remaining"]')).toBeNull();
  expect(popup().querySelector('[data-testid="context-auto-compact"]')).toBeNull();
});

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
