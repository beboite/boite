import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Core } from '../src/core.ts';
import { QuotaStore } from '../src/quotas.ts';
import { QuotaResetError } from '../src/quota-resets.ts';
import { startTestCore, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; });

const reading = () => ({ windows: [{ id: 'week', label: 'Weekly', usedPercent: 0, resetsAt: null }], resetCredits: { availableCount: 0, nextExpiresAt: null } });

function signedIn(core: Core, providerId: string, label: string) {
  const account = { ...core.accounts.add({ providerId, label }), status: 'ok' as const, identity: 'fixture@example.invalid' };
  core.journal.putAccount(account);
  return account;
}

async function claudeFixture() {
  harness = await startTestCore();
  const core = harness.core;
  const account = signedIn(core, 'claude', 'Reset fixture');
  const directory = core.accounts.accountEnv(account, core.providers.require('claude'))['CLAUDE_CONFIG_DIR']!;
  expect(directory.startsWith(harness.dataDir)).toBe(true);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-token' } }));
  writeFileSync(join(directory, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'fixture/organization' } }));
  return { core, account };
}

test('Claude requires confirmation, claims the isolated organization with private grant ids, then broadcasts fresh limits', async () => {
  const { core, account } = await claudeFixture();
  const version = spyOn(core.updates, 'current').mockReturnValue('2.1.286');
  let spent = false;
  const requests: { url: string; init?: RequestInit }[] = [];
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-token', 'User-Agent': 'claude-cli/2.1.286 (external, cli)' });
    if (init?.method === 'POST') { spent = true; return Response.json({ result: 'reset' }); }
    return Response.json({ five_hour: { utilization: spent ? 0 : 100 }, cedar_ember: { eligible: true, next_grant_id: 'private-grant',
      grants: [{ id: 'private-grant', resets_left: spent ? 0 : 1, usable_now: true }] } });
  }, { preconnect: fetch.preconnect }));
  let broadcast: unknown;
  const off = core.bus.onAny((name, value) => { if (name === 'quotas.updated') broadcast = value; });
  try {
    await expect(core.quotas.resets.reset(account.id, false)).rejects.toMatchObject({ data: { field: 'confirmed', expected: true } });
    expect(fetcher).toHaveBeenCalledTimes(0);
    const client = await harness!.connect();
    const result = await client.call('quotas.reset', { accountId: account.id, confirmed: true });
    expect(result).toMatchObject({ outcome: 'reset', quota: { accountId: account.id, status: 'ready', resetCredits: { availableCount: 0 }, windows: [{ usedPercent: 0 }] } });
    expect(requests.map(row => [row.url, row.init?.method ?? 'GET'])).toEqual([
      ['https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1', 'GET'],
      ['https://api.anthropic.com/api/organizations/fixture%2Forganization/reset_rate_limits', 'POST'],
      ['https://api.anthropic.com/api/oauth/usage?cedar_ember=1', 'GET'],
    ]);
    expect(JSON.parse(String(requests[1]!.init!.body))).toEqual({ program: 'cedar_ember', grant_id: 'private-grant', request_id: expect.any(String) });
    expect(JSON.stringify([result, broadcast])).not.toContain('private-grant');
    expect(JSON.stringify([result, broadcast])).not.toContain('fixture-token');
    expect(broadcast).toContainEqual(result.quota);
  } finally { off(); fetcher.mockRestore(); version.mockRestore(); }
});

test('Claude maps definitive outcomes and refuses cooldown or unconfirmed replies without claiming success', async () => {
  const { core, account } = await claudeFixture();
  const version = spyOn(core.updates, 'current').mockReturnValue('2.1.286');
  let answer: string = 'not_limited';
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_input: string | URL | Request, init?: RequestInit) =>
    init?.method === 'POST' ? Response.json({ result: answer }) : Response.json({ five_hour: { utilization: 100 }, cedar_ember: { eligible: true,
      next_grant_id: 'grant', grants: [{ id: 'grant', resets_left: 1, usable_now: true }] } }), { preconnect: fetch.preconnect }));
  try {
    for (const [result, outcome] of [['not_limited', 'nothingToReset'], ['already_used', 'alreadyRedeemed'], ['ineligible', 'noCredit']] as const) {
      answer = result!;
      expect((await core.quotas.resets.reset(account.id, true)).outcome).toBe(outcome!);
    }
    answer = 'cooldown';
    await expect(core.quotas.resets.reset(account.id, true)).rejects.toMatchObject({ settled: true });
    answer = 'unavailable';
    await expect(core.quotas.resets.reset(account.id, true)).rejects.toMatchObject({ settled: false });
  } finally { fetcher.mockRestore(); version.mockRestore(); }
});

test('two overlapping confirmations for aliases of one login consume only one reset and refresh both rows', async () => {
  harness = await startTestCore();
  const core = harness.core;
  const first = signedIn(core, 'codex', 'First');
  const second = signedIn(core, 'codex', 'Alias');
  const directory = spyOn(core.accounts, 'accountEnv').mockReturnValue({ CODEX_HOME: harness.dataDir });
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const store = new QuotaStore(core, async () => reading(), async () => { calls++; await hold; return 'reset'; });
  try {
    const a = store.resets.reset(first.id, true);
    const b = store.resets.reset(second.id, true);
    expect(calls).toBe(1);
    release();
    const results = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(results.map(result => result.quota.accountId)).toEqual([first.id, second.id]);
  } finally { release(); directory.mockRestore(); }
});

test('an unanswered attempt keeps its key across store reconstruction, and a definitive outcome permits a new key', async () => {
  harness = await startTestCore();
  const core = harness.core;
  const account = signedIn(core, 'codex', 'Retry');
  const keys: string[] = [];
  const first = new QuotaStore(core, async () => reading(), async (_account, key) => { keys.push(key); throw new QuotaResetError('fixture timeout'); });
  await expect(first.resets.reset(account.id, true)).rejects.toThrow('fixture timeout');
  const reopened = new QuotaStore(core, async () => reading(), async (_account, key) => { keys.push(key); return 'reset'; });
  await reopened.resets.reset(account.id, true);
  await reopened.resets.reset(account.id, true);
  expect(keys[1]).toBe(keys[0]);
  expect(keys[2]).not.toBe(keys[0]);
});

test('an applied reset with a failed refresh retains a stale reading instead of invented cleared limits', async () => {
  harness = await startTestCore();
  const core = harness.core;
  const account = signedIn(core, 'codex', 'Offline refresh');
  let offline = false;
  const store = new QuotaStore(core, async () => {
    if (offline) throw new Error('fixture refresh failed');
    return { windows: [{ id: 'week', label: 'Weekly', usedPercent: 100, resetsAt: null }], resetCredits: { availableCount: 1, nextExpiresAt: null } };
  }, async () => { offline = true; return 'reset'; });
  await store.list();
  expect(await store.resets.reset(account.id, true)).toMatchObject({ outcome: 'reset', quota: { status: 'unavailable', error: 'fixture refresh failed', windows: [{ usedPercent: 100 }] } });
});

test('unsupported and disabled accounts never run a reset consumer', async () => {
  harness = await startTestCore();
  const core = harness.core;
  const echo = core.accounts.list().find(account => account.providerId === 'echo')!;
  const account = signedIn(core, 'codex', 'Disabled');
  let calls = 0;
  const store = new QuotaStore(core, async () => reading(), async () => { calls++; return 'reset'; });
  await expect(store.resets.reset(echo.id, true)).rejects.toThrow('not supported');
  await store.configure(account.id, false);
  await expect(store.resets.reset(account.id, true)).rejects.toThrow('Enable quota monitoring');
  expect(calls).toBe(0);
});
