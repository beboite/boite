import { afterEach, expect, test } from 'bun:test';
import type { AccountQuota } from '@boite/contracts';
import { QuotaStore, claudeQuotaWindows, codexQuotaWindows } from '../src/quotas.ts';
import { startTestCore, type TestCore } from './harness.ts';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test('a blocked provider does not delay another provider or its progress event', async () => {
  harness = await startTestCore();
  const slow = harness.core.accounts.add({ providerId: 'claude', label: 'Slow' });
  const fast = harness.core.accounts.add({ providerId: 'codex', label: 'Fast' });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reported: string[] = [];
  let fastReported!: () => void;
  let deadline!: ReturnType<typeof setTimeout>;
  const fastReady = new Promise<void>((resolve, reject) => {
    fastReported = resolve;
    deadline = setTimeout(() => reject(new Error('Codex quota progress did not arrive while Claude was blocked')), 2_000);
  });
  const off = harness.core.bus.onAny((name, payload) => {
    const event = payload as { requestId: string; quota: { accountId: string } };
    if (name === 'quotas.progress' && event.requestId === 'progress-test') {
      reported.push(event.quota.accountId);
      if (event.quota.accountId === fast.id) fastReported();
    }
  });
  const store = new QuotaStore(harness.core, async (account) => {
    if (account.providerId === 'claude') await blocked;
    return [{ id: 'session', label: 'Session', usedPercent: 20, resetsAt: null }];
  });
  const reading = store.list(true, 'progress-test');
  try {
    await fastReady;
    expect(reported).toContain(fast.id);
    expect(reported).not.toContain(slow.id);
  } finally { clearTimeout(deadline); release(); await reading; off(); }
});

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
  // Switching one account off leaves every other reading in the answer and the broadcast.
  const other = harness.core.accounts.add({ providerId: 'claude', label: 'Other' });
  await store.list();
  let broadcast: AccountQuota[] = [];
  const off = harness.core.bus.onAny((name, payload) => { if (name === 'quotas.updated') broadcast = payload as AccountQuota[]; });
  const before = calls;
  const configured = await store.configure(existing.id, false); off();
  expect(calls).toBe(before);
  for (const rows of [configured, broadcast]) {
    const row = rows.find((q) => q.accountId === other.id)!;
    expect([row.status, row.windows.map((w) => w.usedPercent), row.error]).toEqual(['ready', [20], null]);
    expect(rows.find((q) => q.accountId === existing.id)?.status).toBe('disabled');
  }
  const restored = new QuotaStore(harness.core, async () => { throw new Error('fixture offline'); });
  expect((await restored.list()).find((q) => q.accountId === existing.id)?.status).toBe('disabled');
  expect(await store.configure(existing.id, true)).toContainEqual(expect.objectContaining({ accountId: existing.id, enabled: true, windows: [] }));
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

test('a failed read after an invalidation shows the last good reading as stale until the login changes hands', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Default' });
  let failure: string | null = null;
  const store = new QuotaStore(harness.core, async () => {
    if (failure) throw new Error(failure);
    return [{ id: 'five_hour', label: '5 hours', usedPercent: 40, resetsAt: null }];
  });
  const good = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(good.status).toBe('ready');
  // An agent update check announces providers.updated and clears the cache.
  harness.core.bus.emit('providers.updated', harness.core.providers.list());
  failure = 'Claude quota requests are rate limited. Retrying in five minutes.';
  const stale = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(stale).toMatchObject({ status: 'unavailable', windows: good.windows, checkedAt: good.checkedAt, error: failure });
  // Signed in as someone else: the old reading is not theirs.
  const [first, second] = [{ ...account, identity: 'a@example.com' }, { ...account, identity: 'b@example.com' }];
  harness.core.bus.emit('accounts.updated', first);
  expect((await store.list()).find((q) => q.accountId === account.id)?.windows).toEqual(good.windows);
  harness.core.bus.emit('accounts.updated', second);
  expect((await store.list()).find((q) => q.accountId === account.id)).toMatchObject({ windows: [], checkedAt: null, error: failure });
});

test('the standalone Antigravity source is opt-in, persists and never borrows an ACP account', async () => {
  harness = await startTestCore();
  const reads: string[] = [];
  const read = async (account: { id: string }) => { reads.push(account.id); return [{ id: 'session', label: '5 hours', usedPercent: 30, resetsAt: null }]; };
  const store = new QuotaStore(harness.core, read);
  expect((await store.list()).find((row) => row.accountId === 'quota:antigravity-cli')?.status).toBe('disabled');
  expect(reads).not.toContain('quota:antigravity-cli');
  await store.configure('quota:antigravity-cli', true);
  expect((await store.list()).find((row) => row.accountId === 'quota:antigravity-cli')?.status).toBe('ready');
  expect(reads).toContain('quota:antigravity-cli');
  await store.configure('quota:antigravity-cli', false);
  const restored = new QuotaStore(harness.core, read);
  expect((await restored.list()).find((row) => row.accountId === 'quota:antigravity-cli')?.status).toBe('disabled');
});
