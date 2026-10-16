import { afterEach, expect, test, spyOn } from 'bun:test';
import type { AccountQuota } from '@boite/contracts';
import { QuotaStore, claudeQuotaWindows, claudeUsageAgent, codexQuotaWindows, type QuotaReader } from '../src/quotas.ts';
import { claudeQuotaDetails, codexQuotaDetails, museQuotaReading } from '../src/quota-details.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { codexQuotaError } from '../src/drivers/codex/models.ts';
import type { QueryFn } from '../src/drivers/claude/query.ts';
import { scriptedClaude, startTestCore, waitFor, type TestCore } from './harness.ts';
let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

test('Claude collects resets and the budget with one GET against the isolated login, without spending or redeeming', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Fixture' });
  const directory = harness.core.accounts.accountEnv(account, harness.core.providers.require('claude'))['CLAUDE_CONFIG_DIR']!;
  expect(directory.startsWith(harness.dataDir)).toBe(true);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  const accounts = spyOn(harness.core.accounts, 'list').mockReturnValue([account]);
  // Anthropic answers `eligible: false` to a caller that does not name a recent CLI.
  const version = spyOn(harness.core.updates, 'current').mockReturnValue('2.1.286');
  const fakeFetch: typeof fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage?cedar_ember=1');
    expect(options?.method ?? 'GET').toBe('GET');
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-token', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/2.1.286 (external, cli)' });
    expect(options?.redirect).toBe('error');
    return Response.json({ five_hour: { utilization: 100 }, cedar_ember: { eligible: true, next_grant_id: 'fixture-reset',
      grants: [{ id: 'fixture-reset', resets_left: 1, usable_now: true }] },
      extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25 } });
  }, { preconnect: fetch.preconnect });
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  try {
    const row = (await harness.core.quotas.list()).find((row) => row.accountId === account.id)!;
    expect(row).toMatchObject({ status: 'ready', resetCredits: { availableCount: 1, nextExpiresAt: null },
      credits: { kind: 'budget', enabled: true, remaining: 75, limit: 100 } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A spending budget is usable quota data even when subscription windows are absent.
    fetcher.mockResolvedValue(Response.json({ extra_usage: { is_enabled: true, monthly_limit: 100, used_credits: 25 } }));
    harness.core.quotas.invalidate();
    expect((await harness.core.quotas.list()).find((row) => row.accountId === account.id)).toMatchObject({
      status: 'ready', windows: [], credits: { remaining: 75, limit: 100 },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  } finally { fetcher.mockRestore(); accounts.mockRestore(); version.mockRestore(); }
  expect(claudeUsageAgent(null)).toEqual({});
  expect(claudeUsageAgent('2.1\r\nX: y')).toEqual({});
});

test('an empty Claude HTTP response falls back to the same account CLI without sending a prompt', async () => {
  harness = await startTestCore();
  scriptedClaude(harness);
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Fixture' });
  const directory = harness.core.accounts.accountEnv(account, harness.core.providers.require('claude'))['CLAUDE_CONFIG_DIR']!;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  const accounts = spyOn(harness.core.accounts, 'list').mockReturnValue([account]);
  const fetcher = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ five_hour: null, seven_day: null }));
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const prompts: unknown[] = [];
  let closed = false;
  const query = spyOn(sdk, 'query').mockImplementation(({ prompt, options }) => {
    expect(options?.env?.['CLAUDE_CONFIG_DIR']).toBe(directory);
    void (async () => { for await (const value of prompt as AsyncIterable<unknown>) prompts.push(value); })();
    return {
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({ rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 42 }, seven_day: { utilization: 7 } } }),
      close: () => { closed = true; },
    } as unknown as ReturnType<QueryFn>;
  });
  try {
    let calls = 0;
    for (const response of [{ five_hour: null, seven_day: null }, { extra_usage: { is_enabled: false } }]) {
      fetcher.mockResolvedValue(Response.json(response));
      harness.core.quotas.invalidate();
      closed = false;
      const row = (await harness.core.quotas.list()).find((row) => row.accountId === account.id)!;
      expect(row.status).toBe('ready');
      expect(row.windows.map((window) => window.usedPercent)).toEqual([42, 7]);
      expect(fetcher).toHaveBeenCalledTimes(++calls);
      expect(query).toHaveBeenCalledTimes(calls);
      expect(closed).toBe(true);
      expect(prompts).toEqual([]);
    }
  } finally { query.mockRestore(); fetcher.mockRestore(); accounts.mockRestore(); }
});

test('Codex trusts the total reset count when details are partial and never infers paid activation', () => {
  const response = { rateLimits: { limitId: 'spark', credits: { hasCredits: true, balance: '999' } },
    rateLimitsByLimitId: { codex: { credits: { hasCredits: true, unlimited: false, balance: '42.5' } } },
    rateLimitResetCredits: { availableCount: 5, credits: [
      { id: 'private-id', status: 'available', resetType: 'codexRateLimits', expiresAt: 1900000000 },
      { status: 'consumed', expiresAt: 1800000000 },
    ] } };
  expect(codexQuotaDetails(response)).toEqual({ resetCredits: { availableCount: 5, nextExpiresAt: 1900000000000 },
    credits: { kind: 'balance', enabled: null, remaining: 42.5, limit: null, unlimited: false } });
  expect(codexQuotaDetails({ rateLimitResetCredits: { availableCount: 2, credits: null } }).resetCredits).toEqual({ availableCount: 2, nextExpiresAt: null });
  expect(codexQuotaDetails({ rateLimitResetCredits: { availableCount: 0, credits: response.rateLimitResetCredits.credits } }).resetCredits?.nextExpiresAt).toBeNull();
  expect(codexQuotaDetails({ rateLimits: { credits: { hasCredits: true, balance: 'bad' } } }).credits?.remaining).toBeNull();
});

test('Claude reports the earliest usable expiration and keeps spending caps separate from wallets', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const grant = { id: 'next', resets_left: 2, usable_now: true, ends_at: '2026-03-01T00:00:00Z' };
  const raw = { cedar_ember: { eligible: true, next_grant_id: 'next', grants: [grant,
    { ...grant, id: 'paused', paused: true }, { ...grant, id: 'inactive', usable_now: false },
    { ...grant, id: 'expired', ends_at: '2025-01-01T00:00:00Z' },
    { ...grant, id: 'invalid-date', ends_at: '2026-02-30T00:00:00Z' },
    { ...grant, id: 'later', resets_left: 1, ends_at: null },
    { ...grant, id: 'sooner', resets_left: 1, ends_at: '2026-02-01T00:00:00Z' },
  ] }, extra_usage: { is_enabled: true, monthly_limit: 2000, used_credits: 500 } };
  expect(claudeQuotaDetails(raw, now)).toEqual({ resetCredits: { availableCount: 4, nextExpiresAt: Date.parse('2026-02-01T00:00:00Z') },
    credits: { kind: 'budget', enabled: true, remaining: 1500, limit: 2000, unlimited: false } });
  expect(claudeQuotaDetails({ ...raw, cedar_ember: { ...raw.cedar_ember, next_grant_id: 'missing' } }, now).resetCredits?.availableCount).toBe(4);
  expect(claudeQuotaDetails({ extra_usage: { is_enabled: false, monthly_limit: 20, used_credits: 5 } }).credits?.enabled).toBe(false);
  expect(claudeQuotaDetails({ extra_usage: { is_enabled: true, monthly_limit: null, used_credits: 5 } }).credits?.remaining).toBeNull();
  expect(claudeQuotaDetails({})).toEqual({});
});

test('Muse preserves observation milliseconds and does not invent a zero reading from an empty cache', () => {
  expect(museQuotaReading({})).toBeNull();
  expect(museQuotaReading({ observedAtMs: 1900000000000, window: { usedPercent: 120, windowDurationMins: 300, resetsAtMs: 1900010000000 },
    weekly: { usedPercent: 0, resetsAtMs: 1900100000000 } })).toEqual({ observedAt: 1900000000000, reading: { windows: [
      { id: 'window', label: '5 hours', usedPercent: 100, resetsAt: 1900010000000 },
      { id: 'weekly', label: 'Weekly', usedPercent: 0, resetsAt: 1900100000000 },
    ] } });
});

test('failed reads retain extras as stale, successful omissions clear them, and disabled accounts expose none', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'claude', label: 'Fixture' });
  let mode = 'extras';
  const store = new QuotaStore(harness.core, async () => {
    if (mode === 'error') throw new Error('fixture offline');
    const windows = [{ id: 'session', label: '5 hours', usedPercent: 100, resetsAt: null }];
    return mode === 'extras' ? { windows, resetCredits: { availableCount: 2, nextExpiresAt: null },
      credits: { kind: 'budget' as const, enabled: true, remaining: 75, limit: 100, unlimited: false } } : { windows };
  });
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    const row = async () => (await store.list(true)).find((row) => row.accountId === account.id)!;
    const first = await row();
    mode = 'error'; now += 11_000;
    expect(await row()).toMatchObject({ status: 'unavailable', resetCredits: first.resetCredits, credits: first.credits, checkedAt: first.checkedAt });
    mode = 'empty'; now += 301_000;
    expect((await row()).resetCredits).toBeUndefined();
    expect((await row()).credits).toBeUndefined();
    mode = 'extras'; now += 11_000;
    expect((await row()).resetCredits?.availableCount).toBe(2);
    await store.configure(account.id, false);
    expect(await row()).toMatchObject({ status: 'disabled', windows: [] });
    expect((await row()).credits).toBeUndefined();
  } finally { clock.mockRestore(); }
});

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
  const store = new QuotaStore(harness.core, async (account) => {
    if (account.providerId === 'claude') await blocked;
    return [{ id: 'session', label: 'Session', usedPercent: 20, resetsAt: null }];
  });
  const reading = store.list(true, 'progress-test', (quota) => {
    reported.push(quota.accountId);
    if (quota.accountId === fast.id) fastReported();
  });
  try {
    await fastReady;
    expect(reported).toContain(fast.id);
    expect(reported).not.toContain(slow.id);
  } finally { clearTimeout(deadline); release(); await reading; }
});

test('Codex selects the account bucket and respects monthly plans and reset seconds', () => {
  const result = codexQuotaWindows({ rateLimits: { limitId: 'spark', primary: { usedPercent: 99 } }, rateLimitsByLimitId: {
    codex: { planType: 'free', primary: { usedPercent: 31, resetsAt: 1900000000 }, secondary: null },
  } });
  expect(result).toEqual([{ id: 'primary', label: 'Monthly', usedPercent: 31, resetsAt: 1900000000000 }]);
  expect(codexQuotaWindows({ rateLimits: { limitId: 'spark', primary: { usedPercent: 99 } } })).toEqual([]);
});
test('a Codex quota failure blames the login only when Codex reports a login problem', () => {
  // The two reasons below are what codex-cli 0.159.3 answers to account/rateLimits/read.
  expect(codexQuotaError('codex account authentication required to read rate limits').message).toContain('Check its login in Providers');
  const offline = codexQuotaError('failed to fetch codex rate limits: error sending request for url (https://chatgpt.com/backend-api/wham/usage)').message;
  expect(offline).toContain('could not reach OpenAI');
  expect(offline).not.toContain('login');
  expect(codexQuotaError('unexpected payload').message).toBe('Codex could not read subscription quotas: unexpected payload');
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
  let empty = false;
  const store = new QuotaStore(harness.core, async () => {
    if (failure) throw new Error(failure);
    if (empty) return { windows: [] };
    return { windows: [{ id: 'five_hour', label: '5 hours', usedPercent: 40, resetsAt: null }],
      resetCredits: { availableCount: 2, nextExpiresAt: null },
      credits: { kind: 'budget' as const, enabled: true, remaining: 75, limit: 100, unlimited: false } };
  });
  const good = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(good.status).toBe('ready');
  // An agent update check announces providers.updated and clears the cache.
  harness.core.bus.emit('providers.updated', harness.core.providers.list());
  failure = 'Claude quota requests are rate limited. Retrying in five minutes.';
  const stale = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(stale).toMatchObject({ status: 'unavailable', windows: good.windows, checkedAt: good.checkedAt, error: failure,
    resetCredits: good.resetCredits, credits: good.credits });
  failure = null; empty = true;
  harness.core.bus.emit('providers.updated', harness.core.providers.list());
  const missing = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(missing).toMatchObject({ status: 'unavailable', windows: good.windows, checkedAt: good.checkedAt,
    resetCredits: good.resetCredits, credits: good.credits,
    error: 'No subscription usage limits were returned. Retrying in five minutes.' });
  empty = false; failure = 'fixture offline';
  // Signed in as someone else: the old reading is not theirs.
  const [first, second] = [{ ...account, identity: 'a@example.com' }, { ...account, identity: 'b@example.com' }];
  harness.core.bus.emit('accounts.updated', first);
  expect((await store.list()).find((q) => q.accountId === account.id)?.windows).toEqual(good.windows);
  harness.core.bus.emit('accounts.updated', second);
  const changed = (await store.list()).find((q) => q.accountId === account.id)!;
  expect(changed).toMatchObject({ windows: [], checkedAt: null, error: failure });
  expect(changed.resetCredits).toBeUndefined();
  expect(changed.credits).toBeUndefined();
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

test('a Codex session reading merges into the last full read and stands as a fresh one', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'codex', label: 'Codex' });
  const accounts = spyOn(harness.core.accounts, 'list').mockReturnValue([account]);
  let calls = 0;
  const store = new QuotaStore(harness.core, async () => {
    calls++;
    return { windows: [{ id: 'primary', label: '5 hours', usedPercent: 10, resetsAt: null }, { id: 'secondary', label: 'Weekly', usedPercent: 20, resetsAt: null }],
      resetCredits: { availableCount: 2, nextExpiresAt: null } };
  });
  let updates = 0;
  const off = harness.core.bus.onAny((name) => { if (name === 'quotas.updated') updates++; });
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const observed = { windows: [{ id: 'primary', label: '5 hours', usedPercent: 42, resetsAt: null }] };
  const row = async () => (await store.list()).find((row) => row.accountId === account.id)!;
  try {
    // With no full read held, a sparse update cannot stand for one: the list reads.
    store.observe(account.id, observed, now);
    expect(updates).toBe(0);
    expect((await row()).windows[0]!.usedPercent).toBe(10);
    expect(calls).toBe(1);
    // The update replaces the window it carries; the other window and the banked resets stay.
    now += 5_000;
    store.observe(account.id, observed, now);
    expect(updates).toBe(1);
    now += 50_000;
    expect(await row()).toMatchObject({ status: 'ready', source: 'observation', checkedAt: now - 50_000, resetCredits: { availableCount: 2 },
      windows: [observed.windows[0], { id: 'secondary', usedPercent: 20 }] });
    expect(calls).toBe(1);
    // The same limits again change nothing a client shows; an older reading does not replace a newer one.
    store.observe(account.id, observed, now);
    expect(updates).toBe(1);
    store.observe(account.id, { windows: [{ id: 'primary', label: '5 hours', usedPercent: 99, resetsAt: null }] }, now - 1_000);
    expect((await row()).windows[0]!.usedPercent).toBe(42);
    // Five minutes after the full read, updates stop standing in for it: the next list reads again.
    now += 250_000;
    store.observe(account.id, { windows: [{ id: 'primary', label: '5 hours', usedPercent: 50, resetsAt: null }] }, now);
    now += 61_000;
    expect((await row()).windows[0]!.usedPercent).toBe(10);
    expect(calls).toBe(2);
    // A reading with no limits, or for a disabled account, is not one.
    store.observe(account.id, { windows: [] }, now + 1);
    expect((await row()).checkedAt).toBe(now);
    await store.configure(account.id, false);
    store.observe(account.id, observed, now + 2);
    expect((await row()).status).toBe('disabled');
  } finally { off(); clock.mockRestore(); accounts.mockRestore(); }
});

test('quota progress reaches the connection that asked and no other', async () => {
  harness = await startTestCore();
  const accounts = [harness.core.accounts.add({ providerId: 'claude', label: 'A' }), harness.core.accounts.add({ providerId: 'codex', label: 'B' })];
  const list = spyOn(harness.core.accounts, 'list').mockReturnValue(accounts);
  let calls = 0;
  (harness.core.quotas as unknown as { read: QuotaReader }).read = async () => { calls++; return [{ id: 'session', label: '5 hours', usedPercent: 5, resetsAt: null }]; };
  const caller = await harness.connect();
  const other = await harness.connect();
  const frames = { caller: 0, other: 0 };
  caller.on('quotas.progress', (event) => { if (event.requestId === 'mine') frames.caller++; });
  other.on('quotas.progress', () => { frames.other++; });
  try {
    const rows = await caller.call('quotas.list', { refresh: true, requestId: 'mine' });
    // A response follows every event sent before it on that socket.
    await other.call('quotas.list', {});
    expect(calls).toBe(2);
    expect(frames).toEqual({ caller: rows.length, other: 0 });
  } finally { caller.close(); other.close(); list.mockRestore(); }
});

test('changing one account re-reads that account only and keeps the others in flight', async () => {
  harness = await startTestCore();
  const a = harness.core.accounts.add({ providerId: 'claude', label: 'A' });
  const b = harness.core.accounts.add({ providerId: 'codex', label: 'B' });
  const list = spyOn(harness.core.accounts, 'list').mockReturnValue([a, b]);
  const reads: string[] = [];
  let hold: Promise<void> | null = null;
  const store = new QuotaStore(harness.core, async (account) => {
    reads.push(account.id);
    if (account.id === b.id && hold) await hold;
    return [{ id: 'session', label: '5 hours', usedPercent: 5, resetsAt: null }];
  });
  try {
    await store.list();
    expect(reads.sort()).toEqual([a.id, b.id].sort());
    reads.length = 0;
    // A rename of A, as accounts.updated announces it.
    harness.core.bus.emit('accounts.updated', { ...a, label: 'A renamed' });
    await store.list();
    expect(reads).toEqual([a.id]);
    // B's read in flight when A changes still fills B's cache.
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    store.invalidate(b.id);
    reads.length = 0;
    const pending = store.list();
    await waitFor(() => reads.includes(b.id));
    harness.core.bus.emit('accounts.updated', { ...a, label: 'A again' });
    release(); await pending;
    reads.length = 0;
    await store.list();
    expect(reads).toEqual([a.id]);
    // A provider change still reads everything.
    reads.length = 0;
    harness.core.bus.emit('providers.updated', harness.core.providers.list());
    await store.list();
    expect(reads.sort()).toEqual([a.id, b.id].sort());
  } finally { list.mockRestore(); }
});

test('an Antigravity account has its own limits row, beside the Antigravity CLI one', async () => {
  harness = await startTestCore();
  const account = harness.core.accounts.add({ providerId: 'antigravity', label: 'Google' });
  const read: string[] = [];
  const store = new QuotaStore(harness.core, async (row) => {
    read.push(row.id);
    return { windows: [{ id: 'gemini-5h', label: 'Gemini · 5 hours', usedPercent: 30, resetsAt: null }] };
  });
  const rows = await store.list();
  expect(rows.find((row) => row.accountId === account.id)).toMatchObject({ status: 'ready', enabled: true, windows: [{ id: 'gemini-5h', usedPercent: 30 }] });
  expect(read).toContain(account.id);
  // The CLI's row still waits for the user to turn it on.
  expect(rows.find((row) => row.accountId === 'quota:antigravity-cli')?.status).toBe('disabled');
});
