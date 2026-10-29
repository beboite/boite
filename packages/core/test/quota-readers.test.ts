import { Database } from 'bun:sqlite';
import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../src/core.ts';
import type { Account } from '@boite/contracts';
import { grokQuotaWindows, openCodeQuotaWindows, readExtraQuota } from '../src/quota-readers.ts';
import { forgetAntigravityTokens } from '../src/antigravity-quota.ts';
import { thrown } from './settle.ts';
let directory = '';
let restore: (() => void) | undefined;
afterEach(async () => { restore?.(); restore = undefined; if (directory) await rm(directory, { recursive: true, force: true }); directory = ''; delete process.env.BOITE_DATA_DIR; });

test('Grok omitted proto3 zero is known only with a valid credits period', () => {
  expect(grokQuotaWindows({ config: { currentPeriod: { end: '2026-10-01T00:00:00Z' } } })).toEqual([{ id: 'credits', label: 'Credits', usedPercent: 0, resetsAt: Date.parse('2026-10-01T00:00:00Z') }]);
  expect(grokQuotaWindows({ config: { creditUsagePercent: 0, currentPeriod: { end: '2026-10-01T00:00:00Z' } } })).toEqual([{ id: 'credits', label: 'Credits', usedPercent: 0, resetsAt: Date.parse('2026-10-01T00:00:00Z') }]);
  for (const config of [{}, { currentPeriod: {} }, { currentPeriod: { end: 'invalid' } }, { creditUsagePercent: '25' }, { creditUsagePercent: null, currentPeriod: { end: '2026-10-01T00:00:00Z' } }]) {
    expect(grokQuotaWindows({ config })).toEqual([]);
  }
  expect(grokQuotaWindows({ config: null })).toEqual([]);
});

test('Grok reads legacy credit amounts and prefers the reported percentage', () => {
  const config = { monthlyLimit: { val: 2000 }, used: { val: 500 }, billingPeriodEnd: '2026-10-01T00:00:00Z' };
  expect(grokQuotaWindows({ config })[0]?.usedPercent).toBe(25);
  expect(grokQuotaWindows({ config: { ...config, currentPeriod: { end: config.billingPeriodEnd } } })[0]?.usedPercent).toBe(25);
  expect(grokQuotaWindows({ config: { ...config, used: {} } })[0]?.usedPercent).toBe(0);
  expect(grokQuotaWindows({ config: { ...config, creditUsagePercent: 40 } })[0]?.usedPercent).toBe(40);
  expect(grokQuotaWindows({ config: { ...config, monthlyLimit: {} } })).toEqual([]);
  expect(grokQuotaWindows({ config: { ...config, used: null } })).toEqual([]);
});
test('OpenCode Go percentages below one stay percentages and relative resets use the reading time', () => {
  const now = 1900000000000;
  expect(openCodeQuotaWindows({ usage: { rolling: { percent: 0.5, resetInSec: 60 }, weekly: { percent: 100 }, monthly: { percent: null } } }, now)).toEqual([
    { id: 'rolling', label: '5 hours', usedPercent: 0.5, resetsAt: now + 60000 },
    { id: 'weekly', label: 'Weekly', usedPercent: 100, resetsAt: null },
  ]);
});
test('OpenCode 2 reads the Go key from its database, never from auth.json', async () => {
  directory = await mkdtemp(join(tmpdir(), 'boite-quota-test-'));
  process.env.BOITE_DATA_DIR = directory;
  await mkdir(join(directory, 'opencode'));
  // A version 1 login in the same folder is not version 2's: it signs in on its own.
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-v1-key' } }));
  const core = { accounts: { accountEnv: () => ({ XDG_DATA_HOME: directory }) }, providers: { require: () => ({}) } } as unknown as Core;
  const fakeFetch: typeof fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-v2-key' });
    return Response.json({ usage: { weekly: { percent: 40 } } });
  }, { preconnect: fetch.preconnect });
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  restore = () => fetcher.mockRestore();
  const account = { providerId: 'opencode-v2', isolationDir: directory } as Account;
  expect(await thrown(readExtraQuota(core, account))).toThrow('Connect OpenCode Go');
  const db = new Database(join(directory, 'opencode', 'opencode.db'));
  db.run('CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT, value TEXT, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER, time_updated INTEGER)');
  db.run("INSERT INTO credential VALUES ('cred_go', 'opencode-go', 'OpenCode Go', ?, NULL, NULL, 1, 1, 1)", [JSON.stringify({ type: 'key', key: 'fixture-v2-key' })]);
  db.close();
  expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(40);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('OpenCode reads the isolated Go key and sends it only to its fixed usage endpoint', async () => {
  directory = await mkdtemp(join(tmpdir(), 'boite-quota-test-'));
  process.env.BOITE_DATA_DIR = directory;
  await mkdir(join(directory, 'opencode'));
  await writeFile(join(directory, 'opencode', 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: 'fixture-go-key' }, openai: { type: 'oauth', access: 'fixture-other-token' } }));
  const core = { accounts: { accountEnv: () => ({ XDG_DATA_HOME: directory }) }, providers: { require: () => ({}) } } as unknown as Core;
  const fakeFetch: typeof fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe('https://opencode.ai/zen/go/v1/usage');
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-go-key' });
    expect(options?.redirect).toBe('error');
    return Response.json({ usage: { rolling: { percent: 25 } } });
  }, { preconnect: fetch.preconnect });
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  restore = () => fetcher.mockRestore();
  const account = { providerId: 'opencode', isolationDir: directory } as Account;
  expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(25);
  await writeFile(join(directory, 'opencode', 'auth.json'), '{}');
  expect(await thrown(readExtraQuota(core, account))).toThrow('Connect OpenCode Go');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('an Antigravity account reads its limits from the server sign-in, renewing the access token only when it runs out', async () => {
  directory = await mkdtemp(join(tmpdir(), 'boite-quota-test-'));
  forgetAntigravityTokens();
  const core = { accounts: { accountEnv: () => ({ GEMINI_HOME: directory }) }, providers: { require: () => ({ quirks: ['antigravity'] }) } } as unknown as Core;
  const account = { id: 'acc_agy', providerId: 'antigravity', isolationDir: directory } as Account;
  expect(await thrown(readExtraQuota(core, account))).toThrow('Sign in to Antigravity in Providers');

  await mkdir(join(directory, 'antigravity-acp'));
  await writeFile(join(directory, 'antigravity-acp', 'acp_token.json'), JSON.stringify({ client_id: 'fixture-client', client_secret: 'fixture-secret', refresh_token: 'fixture-refresh', project_id: 'fixture-project' }));
  const calls: string[] = [];
  let summary: unknown = {
    groups: [
      { displayName: 'Gemini', buckets: [
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.25, resetTime: '2026-10-16T18:00:00Z' },
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75 },
        { bucketId: 'gemini-off', window: 'weekly', remainingFraction: 0, disabled: true },
      ] },
      { displayName: 'Claude and GPT', buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1 }] },
    ],
  };
  let issued = 0;
  const refused = new Set<string>();
  const fakeFetch: typeof fetch = Object.assign(async (url: string | URL | Request, options?: RequestInit) => {
    const address = String(url);
    calls.push(address);
    if (address === 'https://oauth2.googleapis.com/token') {
      expect(String(options?.body)).toContain('refresh_token=fixture-refresh');
      issued += 1;
      return Response.json({ access_token: `fixture-access-${issued}`, expires_in: 3600 });
    }
    const bearer = String((options?.headers as Record<string, string>)['Authorization']).replace('Bearer ', '');
    expect(bearer).toBe(`fixture-access-${issued}`);
    if (refused.has(bearer) || refused.has('*')) return new Response('', { status: 401 });
    expect(JSON.parse(String(options?.body))).toEqual({ project: 'fixture-project' });
    if (address.endsWith(':retrieveUserQuotaSummary')) return address.startsWith('https://daily-') ? new Response('', { status: 503 }) : Response.json(summary);
    if (address.endsWith(':fetchAvailableModels')) {
      return Response.json({ models: { 'gemini-3.8-flash': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.5 } }, 'claude-opus-4-6': { quotaInfo: { remainingFraction: 0.2 } }, 'tab-model': { quotaInfo: { remainingFraction: 0 } } } });
    }
    return new Response('', { status: 404 });
  }, { preconnect: fetch.preconnect });
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(fakeFetch);
  restore = () => fetcher.mockRestore();

  // The daily endpoint failed, the stable one answered; the disabled bucket is left out.
  expect(await readExtraQuota(core, account)).toEqual([
    { id: 'gemini-5h', label: 'Gemini · 5 hours', usedPercent: 75, resetsAt: Date.parse('2026-10-16T18:00:00Z') },
    { id: 'gemini-weekly', label: 'Gemini · Weekly', usedPercent: 25, resetsAt: null },
    { id: '3p-weekly', label: 'Claude and GPT · Weekly', usedPercent: 0, resetsAt: null },
  ]);
  // An account whose summary is empty reports per-model quotas instead.
  summary = { groups: [] };
  expect((await readExtraQuota(core, account)).map((row) => [row.label, row.usedPercent])).toEqual([['Gemini · Quota', 50], ['Claude · Quota', 80]]);
  // One renewal for both reads: the access token was still good.
  expect(calls.filter((url) => url.includes('oauth2')).length).toBe(1);
  expect(calls.every((url) => url.startsWith('https://oauth2.googleapis.com/') || url.includes('cloudcode-pa.googleapis.com/v1internal:'))).toBe(true);

  // Google stops taking an access token before its expiry: it is renewed once.
  refused.add('fixture-access-1');
  expect((await readExtraQuota(core, account)).length).toBe(2);
  expect(issued).toBe(2);
  // A fresh token refused too: the sign-in is gone, and the page says so.
  refused.add('*');
  expect(await thrown(readExtraQuota(core, account))).toThrow('The Antigravity sign-in expired');
  expect(issued).toBe(3);
});
