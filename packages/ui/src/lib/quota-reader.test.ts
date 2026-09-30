import { expect, test } from 'vitest';
import type { AccountQuota, RpcEvents } from '@boite/contracts';
import type { Client } from './client';
import { QuotaReader } from './quota-reader.svelte';

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
