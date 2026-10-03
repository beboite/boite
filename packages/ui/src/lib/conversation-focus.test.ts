import { expect, test, vi } from 'vitest';
import type { Client } from './client';
import { ATTENTION_ACTIVITY_MS, ATTENTION_RENEW_MS } from '@boite/contracts';
import { ConversationFocus } from './conversation-focus';

const unprotected = { protectedThreadIds: [], protectAllThreads: false };

test('switching machines releases the old socket even when thread ids collide', () => {
  const first = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
  const second = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
  const focus = new ConversationFocus();
  focus.update(first, 'same-id');
  focus.update(second, 'same-id');
  expect(first.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected });
  expect(second.call).toHaveBeenCalledWith('threads.focus', { threadId: 'same-id', ...unprotected });
  focus.close();
  expect(second.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected });
});

test('input leases survive hidden conversations, skip equivalent updates and protect overflow', () => {
  const client = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
  const focus = new ConversationFocus();
  focus.update(client, null, ['b', 'a']);
  expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, protectedThreadIds: ['a', 'b'], protectAllThreads: false });
  focus.update(client, null, ['a', 'b', 'a']);
  expect(client.call).toHaveBeenCalledTimes(1);
  focus.update(client, null, Array.from({ length: 257 }, (_, i) => `thread-${i}`));
  expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, protectedThreadIds: [], protectAllThreads: true });
  focus.close();
  expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected });
});

test('being looked at is renewed while it lasts, and ends with a report the core can time', () => {
  vi.useFakeTimers();
  try {
    const client = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
    const focus = new ConversationFocus();
    focus.update(client, 't-1', [], false, true);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-1', ...unprotected, attentive: true });
    vi.advanceTimersByTime(ATTENTION_RENEW_MS * 2);
    expect(client.call).toHaveBeenCalledTimes(3);
    // Looking at nothing is not being attentive to it.
    focus.update(client, null, [], false, true);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null, ...unprotected });
    focus.update(client, 't-1', [], false, true);
    focus.update(client, 't-1', [], false, false);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-1', ...unprotected });
    vi.advanceTimersByTime(ATTENTION_RENEW_MS * 2);
    expect(client.call).toHaveBeenCalledTimes(6);
    focus.close();
  } finally { vi.useRealTimers(); }
});

test('the first use after a quiet spell is reported at once, with how long ago the page was used', () => {
  vi.useFakeTimers();
  try {
    const client = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
    const focus = new ConversationFocus();
    focus.activity(Date.now());
    // Use of a page nobody watches is nobody's business.
    expect(client.call).not.toHaveBeenCalled();
    focus.update(client, 't-1', [], false, true);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-1', ...unprotected, attentive: true, idleMs: 0 });
    vi.advanceTimersByTime(1_000);
    focus.activity(Date.now());
    expect(client.call).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(ATTENTION_ACTIVITY_MS);
    focus.activity(Date.now());
    expect(client.call).toHaveBeenCalledTimes(2);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-1', ...unprotected, attentive: true, idleMs: 0 });
    // Looking away says how long ago the page was last used, so the core can tell news seen from news missed.
    vi.advanceTimersByTime(3_000);
    focus.update(client, 't-1', [], false, false);
    expect(client.call).toHaveBeenLastCalledWith('threads.focus', { threadId: 't-1', ...unprotected, idleMs: 3_000 });
    focus.close();
  } finally { vi.useRealTimers(); }
});