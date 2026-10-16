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

/** A connection whose writes complete, or one the browser closed: `transaction` throws InvalidStateError. */
function connection(closed: boolean) {
  const db = {
    onclose: null as (() => void) | null,
    close: vi.fn(),
    transaction: vi.fn(() => {
      if (closed) throw new DOMException('The database connection is closing.', 'InvalidStateError');
      const transaction = {
        oncomplete: null as (() => void) | null,
        onabort: null as (() => void) | null,
        error: null,
        objectStore: () => ({ put: () => Promise.resolve().then(() => transaction.oncomplete?.()) }),
        abort: vi.fn()
      };
      return transaction;
    })
  };
  return db;
}

function serve(connections: ReturnType<typeof connection>[]) {
  const open = vi.fn(() => {
    const request = { result: connections[open.mock.calls.length - 1], onsuccess: null as (() => void) | null };
    Promise.resolve().then(() => request.onsuccess?.());
    return request;
  });
  vi.stubGlobal('indexedDB', { open });
  return open;
}

test('a connection the browser closes is reopened for the next write', async () => {
  const first = connection(false), second = connection(false);
  const open = serve([first, second]);
  const { writeDraftJournal } = await import('./draft-journal');
  await writeDraftJournal('fixture', { text: 'one' });
  first.onclose?.();
  await expect(writeDraftJournal('fixture', { text: 'two' })).resolves.toBeUndefined();
  expect(open).toHaveBeenCalledTimes(2);
  expect(second.transaction).toHaveBeenCalledOnce();
});

test('a write on a connection closed without an event retries once on a fresh one', async () => {
  const dead = connection(true), fresh = connection(false);
  const open = serve([dead, fresh]);
  const { writeDraftJournal } = await import('./draft-journal');
  await expect(writeDraftJournal('fixture', { text: 'kept' })).resolves.toBeUndefined();
  expect(open).toHaveBeenCalledTimes(2);
  expect(dead.transaction).toHaveBeenCalledOnce();
  expect(fresh.transaction).toHaveBeenCalledOnce();
});

test('a second closed connection fails the write instead of retrying forever', async () => {
  const open = serve([connection(true), connection(true), connection(false)]);
  const { writeDraftJournal } = await import('./draft-journal');
  await expect(writeDraftJournal('fixture', {})).rejects.toMatchObject({ name: 'InvalidStateError' });
  expect(open).toHaveBeenCalledTimes(2);
  // The failed connection is not kept either: the next save opens the third.
  await expect(writeDraftJournal('fixture', {})).resolves.toBeUndefined();
  expect(open).toHaveBeenCalledTimes(3);
});
