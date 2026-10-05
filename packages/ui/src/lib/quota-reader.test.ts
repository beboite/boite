import { expect, test, vi } from 'vitest';
import type { AccountQuota, RpcEvents } from '@boite/contracts';
import type { Client } from './client';
import { QuotaReader, REFRESH_SHOWN_MS } from './quota-reader.svelte';

const row = (id: string, used = 20): AccountQuota => ({
  accountId: id, providerId: id, providerName: id, label: id, enabled: true,
  status: 'ready', windows: [{ id: 'week', label: 'Weekly', usedPercent: used, resetsAt: null }], checkedAt: 1, error: null,
});

function fixture() {
  const listeners = new Set<(event: RpcEvents['quotas.progress']) => void>();
  const calls: { requestId: string; resolve(rows: AccountQuota[]): void; reject(error: Error): void }[] = [];
  const client = {
    on: (_: string, listener: (event: RpcEvents['quotas.progress']) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    call: (_: string, params: { requestId: string }) => new Promise<AccountQuota[]>((resolve, reject) => calls.push({ ...params, resolve, reject })),
  } as unknown as Client;
  const emit = (requestId: string, quota: AccountQuota) => listeners.forEach((listener) => listener({ requestId, quota }));
  return { client, calls, emit, listeners };
}

test('each completed account updates while a slower account keeps its last reading', async () => {
  const f = fixture();
  const reader = new QuotaReader('partial-test');
  reader.accept([row('fast'), row('slow')]);
  const reading = reader.read(f.client, true);
  f.emit('another-window', row('fast', 99));
  expect(reader.rows![0]!.windows[0]!.usedPercent).toBe(20);
  f.emit(f.calls[0]!.requestId, row('fast', 60));
  expect(reader.rows).toEqual([row('fast', 60), row('slow')]);
  expect(reader.completed).toEqual(['fast']);
  expect(reader.loading).toBe(true);
  f.emit(f.calls[0]!.requestId, { ...row('slow'), status: 'unavailable', error: 'Offline' });
  expect(reader.completed).toEqual(['fast', 'slow']);
  f.calls[0]!.resolve(reader.rows!);
  await reading;
  expect(reader.loading).toBe(false);
  expect(f.listeners.size).toBe(0);
});

test('a refresh answered at once, as Douane does from its cache, still looks busy for one turn', async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const reader = new QuotaReader('instant-refresh-test');
    reader.accept([row('douane')]);
    const reading = reader.read(f.client, true);
    f.emit(f.calls[0]!.requestId, row('douane', 40));
    f.calls[0]!.resolve([row('douane', 40)]);
    await reading;
    expect(reader.loading).toBe(false);
    expect(reader.rows).toEqual([row('douane', 40)]);
    expect(reader.busy).toBe(true);
    expect(reader.landed).toEqual([]);
    vi.advanceTimersByTime(REFRESH_SHOWN_MS);
    expect(reader.busy).toBe(false);
    expect(reader.landed).toEqual(['douane']);
    // Opening a view reads without the minimum: no grey flash on every open.
    const opening = reader.read(f.client);
    f.calls[1]!.resolve([row('douane', 40)]);
    await opening;
    expect(reader.busy).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('late progress and a late final response cannot replace a newer refresh', async () => {
  const f = fixture();
  const reader = new QuotaReader('overlap-test');
  const first = reader.read(f.client);
  const second = reader.read(f.client, true);
  f.emit(f.calls[1]!.requestId, row('fast', 60));
  f.emit(f.calls[0]!.requestId, row('fast', 99));
  f.calls[0]!.resolve([row('fast', 99)]);
  await first;
  expect(reader.rows).toEqual([row('fast', 60)]);
  expect(reader.loading).toBe(true);
  f.calls[1]!.reject(new Error('Disconnected'));
  await expect(second).rejects.toThrow('Disconnected');
  expect(reader.rows).toEqual([row('fast', 60)]);
  expect(reader.loading).toBe(false);
  expect(f.listeners.size).toBe(0);
});

test('an applied reset wins over an older list without replacing another account', async () => {
  const f = fixture();
  const reader = new QuotaReader('reset-overlap-test');
  reader.accept([row('reset', 100), row('other', 60)]);
  const old = reader.read(f.client, true);
  reader.acceptReset(row('reset', 0));
  f.emit(f.calls[0]!.requestId, row('reset', 100));
  f.calls[0]!.resolve([row('reset', 100), row('other', 99)]);
  await old;
  expect(reader.rows).toEqual([row('reset', 0), row('other', 60)]);
  expect(reader.loading).toBe(false);
  expect(f.listeners.size).toBe(0);
});

test('switching an account off still reads, and a failed read keeps its reason until one lands', async () => {
  const f = fixture();
  const reader = new QuotaReader('configure-test');
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  const configuring = reader.configure(f.client, 'slow', false);
  f.calls[0]!.resolve([row('fast'), { ...row('slow'), enabled: false, status: 'disabled', windows: [] }]);
  await settle();
  // Before, only switching on read again, so the other cards kept what the switch answered.
  expect(f.calls).toHaveLength(2);
  f.calls[1]!.reject(new Error('Disconnected'));
  await configuring;
  expect(reader.error).toBe('Disconnected');
  expect(reader.rows!.map((quota) => quota.accountId)).toEqual(['fast', 'slow']);
  const retry = reader.read(f.client, true);
  f.calls[2]!.resolve([row('fast', 60)]);
  await retry;
  expect(reader.error).toBeNull();
});
