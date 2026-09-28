import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

test('a stalled durable write aborts and rejects instead of holding flush forever', async () => {
  vi.useFakeTimers();
  const transaction = {
    onabort: null as (() => void) | null,
    error: null,
    objectStore: () => ({ put: vi.fn() }),
    abort: vi.fn(() => transaction.onabort?.())
  };
  const db = { transaction: () => transaction, close: vi.fn() };
  vi.stubGlobal('indexedDB', { open: () => {
    const request = { result: db, onsuccess: null as (() => void) | null };
    Promise.resolve().then(() => request.onsuccess?.());
    return request;
  } });
  const { writeDraftJournal } = await import('./draft-journal');
  const writing = writeDraftJournal('fixture', {}).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(transaction.abort).toHaveBeenCalledOnce();
  expect(await writing).toBeInstanceOf(Error);
});
