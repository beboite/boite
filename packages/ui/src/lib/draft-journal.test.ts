import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

test.each(['read', 'write'] as const)('a committed %s waits for completion when its timeout fires first', async (operation) => {
  vi.useFakeTimers();
  const request = { result: { text: 'Keep this draft' } };
  const transaction = {
    oncomplete: null as (() => void) | null,
    onabort: null as (() => void) | null,
    error: null,
    objectStore: () => ({ get: () => request, put: vi.fn() }),
    // IndexedDB has committed, but the browser has not delivered oncomplete yet.
    abort: vi.fn(() => { throw new DOMException('The transaction has finished', 'InvalidStateError'); })
  };
  const db = { transaction: () => transaction, close: vi.fn() };
  vi.stubGlobal('indexedDB', { open: () => {
    const opening = { result: db, onsuccess: null as (() => void) | null };
    Promise.resolve().then(() => opening.onsuccess?.());
    return opening;
  } });
  const { readDraftJournal, writeDraftJournal } = await import('./draft-journal');
  const pending = operation === 'read' ? readDraftJournal('fixture') : writeDraftJournal('fixture', request.result);
  await vi.advanceTimersByTimeAsync(3000);
  expect(transaction.abort).toHaveBeenCalledOnce();
  transaction.oncomplete?.();
  await expect(pending).resolves.toEqual(operation === 'read' ? request.result : undefined);
});

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
