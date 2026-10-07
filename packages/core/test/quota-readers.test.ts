import { Database } from 'bun:sqlite';
import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Core } from '../src/core.ts';
import type { Account } from '@boite/contracts';
import { antigravityQuotaWindows, grokQuotaWindows, openCodeQuotaWindows, readExtraQuota, supportsAntigravityUsage } from '../src/quota-readers.ts';
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
test('Antigravity requires a usage command, preserves groups and refuses unknown or disabled buckets', () => {
  const groups = [{ name: 'Gemini', buckets: [{ id: '5h', window: '5h', remaining_fraction: 1 }, { id: 'weekly', remaining_fraction: 0, disabled: true }, { id: 'missing' }] }, { name: 'Claude and GPT', buckets: [{ id: '5h', window: '5h', remaining_fraction: 0.4 }] }];
  const result = antigravityQuotaWindows({ status: 'SUCCESS', command: { name: 'usage', data: { groups } } });
  expect(result.map((row) => [row.id, row.usedPercent])).toEqual([['0:5h', 0], ['1:5h', 60]]);
  expect(() => antigravityQuotaWindows({ status: 'ERROR', command: { name: 'usage' } })).toThrow('successful usage report');
  expect(() => antigravityQuotaWindows({ status: 'SUCCESS', command: { name: 'models' } })).toThrow('successful usage report');
});
test('Antigravity print mode is gated on a stable supported version', () => {
  for (const version of ['1.1.11', 'agy 1.2.2', '2.0.0']) expect(supportsAntigravityUsage(version)).toBe(true);
  for (const version of ['1.1.10', '1.0.99', '1.2.2-preview', '1.2.2.3', 'running']) expect(supportsAntigravityUsage(version)).toBe(false);
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
  await expect(readExtraQuota(core, account)).rejects.toThrow('Connect OpenCode Go');
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
  await expect(readExtraQuota(core, account)).rejects.toThrow('Connect OpenCode Go');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
