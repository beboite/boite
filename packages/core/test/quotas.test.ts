import { afterEach, expect, test } from 'bun:test';
import { QuotaStore, claudeQuotaWindows, codexQuotaWindows } from '../src/quotas.ts';
import { startTestCore, type TestCore } from './harness.ts';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test('Codex selects the account bucket and respects monthly plans and reset seconds', () => {
  const result = codexQuotaWindows({ rateLimits: { limitId: 'spark', primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { planType: 'free', primary: { usedPercent: 31, resetsAt: 1900000000 }, secondary: null },
  } });
  expect(result).toEqual([{ id: 'primary', label: 'Monthly', usedPercent: 31, resetsAt: 1900000000000 }]);
  expect(codexQuotaWindows({ rateLimits: { limitId: 'spark', primary: { usedPercent: 99 } } })).toEqual([]);
});
test('Claude retains zero readings, rejects missing percentages and includes model windows', () => {
  expect(claudeQuotaWindows({ five_hour: { utilization: 0, resets_at: '2026-09-12T10:00:00Z' },
    seven_day: { utilization: null }, model_scoped: [{ display_name: 'Model A', utilization: 110, resets_at: 'invalid' }] })).toEqual([
    { id: 'five_hour', label: '5 hours', usedPercent: 0, resetsAt: Date.parse('2026-09-12T10:00:00Z') },
    { id: 'model:Model A', label: 'Weekly · Model A', usedPercent: 100, resetsAt: null },
  ]);
});
test('quota readers share concurrent work and disabling persists without starting a read', async () => {
  harness = await startTestCore();
  const existing = harness.core.accounts.add({ providerId: 'codex', label: 'Fixture' });
  let calls = 0;
  const store = new QuotaStore(harness.core, async () => { calls++; await Bun.sleep(10); return [{ id: 'session', label: 'Session', usedPercent: 20, resetsAt: null }]; });
  const [first, second] = await Promise.all([store.list(), store.list()]);
  const supported = first.filter((q) => q.status === 'ready').length;
  expect(calls).toBe(supported);
  expect(first).toEqual(second);
  await store.list(true); expect(calls).toBe(supported);
  await store.configure(existing.id, false); expect(calls).toBe(supported);
  const restored = new QuotaStore(harness.core, async () => { throw new Error('fixture offline'); });
  expect((await restored.list()).find((q) => q.accountId === existing.id)?.status).toBe('disabled');
  expect(await store.configure(existing.id, true)).toContainEqual(expect.objectContaining({ accountId: existing.id, enabled: true }));
});
test('unsupported providers do not run a reader and failures are backed off', async () => {
  harness = await startTestCore();
  let calls = 0;
  const store = new QuotaStore(harness.core, async () => { calls++; throw new Error('fixture offline'); });
  const first = await store.list();
  const count = calls;
  expect(first.find((row) => row.providerId === 'echo')?.status).toBe('unsupported');
  await store.list(true); expect(calls).toBe(count);
  expect(first.filter((row) => row.error).every((row) => row.checkedAt === null && row.windows.length === 0)).toBe(true);
});
