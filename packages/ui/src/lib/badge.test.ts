import { expect, test, vi } from 'vitest';
import { attentionCount, syncAppBadge } from './badge';

test('the count is the threads waiting or unread on every machine, archived ones aside', () => {
  expect(attentionCount([
    { threads: [{ unread: true }, { status: 'waiting' }, { status: 'idle' }, { unread: true, archived: true }] },
    { threads: [{ status: 'waiting', unread: true }] }
  ])).toBe(3);
  expect(attentionCount([])).toBe(0);
});

test('the icon badge is set to the count, cleared at zero, and absent or refusing APIs are no error', async () => {
  const setAppBadge = vi.fn(async () => undefined);
  const clearAppBadge = vi.fn(async () => undefined);
  syncAppBadge(4, { setAppBadge, clearAppBadge });
  syncAppBadge(0, { setAppBadge, clearAppBadge });
  expect(setAppBadge).toHaveBeenCalledWith(4);
  expect(clearAppBadge).toHaveBeenCalledOnce();
  expect(() => syncAppBadge(2, {})).not.toThrow();
  expect(() => syncAppBadge(2, { setAppBadge: () => { throw new Error('not installed'); } })).not.toThrow();
  const rejected = vi.fn(() => Promise.reject(new Error('denied')));
  syncAppBadge(1, { setAppBadge: rejected });
  await Promise.resolve();
  expect(rejected).toHaveBeenCalledOnce();
});
