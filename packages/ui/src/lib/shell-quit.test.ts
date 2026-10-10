import { afterEach, expect, test, vi } from 'vitest';
import type { ThreadSummary } from '@boite/contracts';
import { Store } from './store.svelte';
import { confirm } from './confirm.svelte';
import { confirmedQuitHold, QUIT_CHECK_TIMEOUT_MS, shellQuit } from './shell-quit';
import { strings } from './strings';

afterEach(() => { confirm.answer(false); vi.restoreAllMocks(); vi.useRealTimers(); });

function machine(statuses: ThreadSummary['status'][], disconnected = false) {
  return {
    connection: disconnected ? 'closed' : 'ready',
    threads: statuses.map((status, i) => ({ id: `t-${i}`, status })),
    client: { call: vi.fn(async () => statuses.map((status, i) => ({ id: `t-${i}`, status }))) },
  } as unknown as Store;
}

test('idle machines close without asking; work on another machine requires confirmation', async () => {
  const idle = machine(['idle', 'error']);
  const quit = vi.fn(async () => {});
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(false);
  await shellQuit(() => [idle], quit)();
  expect(quit).toHaveBeenCalledTimes(1);
  expect(ask).not.toHaveBeenCalled();
  const busy = machine(['queued', 'running', 'waiting']);
  const request = shellQuit(() => [idle, busy, busy], quit);
  await request();
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('3'), danger: true }));
  expect(quit).toHaveBeenCalledTimes(1);
  ask.mockResolvedValue(true);
  await request();
  expect(quit).toHaveBeenCalledTimes(2);
  expect(busy.client!.call).toHaveBeenCalledWith('threads.list', { includeArchived: true });
});

test('cancelling a keyboard close permits a second hold, while disposal during confirmation remains final', async () => {
  vi.useFakeTimers();
  const quit = vi.fn(async () => {});
  const request = shellQuit(() => [machine(['running'])], quit);
  const hold = confirmedQuitHold(request, { onHolding: () => {}, hasQuit: () => false, failed: error => { throw error; } });
  hold.press();
  await vi.advanceTimersByTimeAsync(1200);
  expect(confirm.current).not.toBeNull();
  confirm.answer(false);
  await vi.advanceTimersByTimeAsync(0);
  hold.press();
  await vi.advanceTimersByTimeAsync(1200);
  expect(confirm.current).not.toBeNull();
  hold.dispose();
  confirm.answer(false);
  await vi.advanceTimersByTimeAsync(0);
  hold.press();
  await vi.advanceTimersByTimeAsync(1200);
  expect(confirm.current).toBeNull();
  expect(quit).not.toHaveBeenCalled();
});

test('disconnected or failed reads ask before closing and repeated exit gestures share the same dialog', async () => {
  const offline = machine(['idle'], true);
  const failing = machine(['idle']);
  vi.mocked(failing.client!.call).mockRejectedValue(new Error('Unavailable'));
  const quit = vi.fn(async () => {});
  const request = shellQuit(() => [offline, failing], quit);
  const first = request();
  expect(request()).toBe(first);
  await vi.waitFor(() => expect(confirm.current).not.toBeNull());
  expect(confirm.current!.body).toContain(strings.titlebar.quitUnknownBody);
  confirm.answer(false);
  await first;
  expect(quit).not.toHaveBeenCalled();
  expect(failing.client!.call).toHaveBeenCalledTimes(1);
});

test('fresh thread state includes work absent from the visible list', async () => {
  const owner = machine(['idle']);
  vi.mocked(owner.client!.call).mockResolvedValue([{ id: 'child', status: 'running', parentThreadId: 'root' }] as never);
  const quit = vi.fn(async () => {});
  const ask = vi.spyOn(confirm, 'ask').mockResolvedValue(true);
  await shellQuit(() => [owner], quit)();
  expect(ask).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(strings.titlebar.quitWorkingOne) }));
  expect(quit).toHaveBeenCalledOnce();
});

test('a stalled machine cannot hold the close request until the RPC timeout', async () => {
  vi.useFakeTimers();
  const owner = machine(['running']);
  vi.mocked(owner.client!.call).mockReturnValue(new Promise(() => {}));
  const quit = vi.fn(async () => {});
  const closing = shellQuit(() => [owner], quit)();
  await vi.advanceTimersByTimeAsync(QUIT_CHECK_TIMEOUT_MS);
  expect(confirm.current?.body).toContain(strings.titlebar.quitUnknownBody);
  confirm.answer(true);
  await closing;
  expect(quit).toHaveBeenCalledOnce();
});
