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
