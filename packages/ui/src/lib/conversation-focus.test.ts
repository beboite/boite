import { expect, test, vi } from 'vitest';
import type { Client } from './client';
import { ConversationFocus } from './conversation-focus';

test('switching machines releases the old socket even when thread ids collide', () => {
  const first = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
  const second = { state: 'ready', call: vi.fn().mockResolvedValue({ ok: true }) } as unknown as Client;
  const focus = new ConversationFocus();
  focus.update(first, 'same-id');
  focus.update(second, 'same-id');
  expect(first.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null });
  expect(second.call).toHaveBeenCalledWith('threads.focus', { threadId: 'same-id' });
  focus.close();
  expect(second.call).toHaveBeenLastCalledWith('threads.focus', { threadId: null });
});
