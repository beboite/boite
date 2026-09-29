import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from '@boite/contracts';
import type { Core } from '../src/core.ts';
import { readExtraQuota } from '../src/quota-readers.ts';

const scope = 'https://auth.x.ai::fixture-client';
const billing = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const tokenEndpoint = 'https://auth.x.ai/oauth2/token';
const account = { providerId: 'grok', isolationDir: 'fixture' } as Account;
const expired = {
  key: 'fixture-expired-access', refresh_token: 'fixture-refresh',
  expires_at: '2000-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'fixture-client',
  principal_type: 'team', principal_id: 'fixture-team', email: 'fixture@example.test',
};
const fresh = { ...expired, key: 'fixture-current-access', expires_at: '2099-01-01T00:00:00Z' };
let directory: string;
let restore: (() => void) | undefined;
let core: Core;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'boite-grok-quota-'));
  process.env.BOITE_DATA_DIR = directory;
  core = { accounts: { accountEnv: () => ({ GROK_HOME: directory }) }, providers: { require: () => ({}) } } as unknown as Core;
});
afterEach(async () => {
  restore?.(); restore = undefined;
  await rm(directory, { recursive: true, force: true });
  delete process.env.BOITE_DATA_DIR;
});

const save = (auth: unknown) => writeFile(join(directory, 'auth.json'), JSON.stringify(auth));
const load = async () => JSON.parse(await readFile(join(directory, 'auth.json'), 'utf8'));
const report = () => Response.json({ config: { creditUsagePercent: 25 } });
function mockFetch(handler: (url: string, options?: RequestInit) => Promise<Response>) {
  const fetcher = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    (url: string | URL | Request, options?: RequestInit) => handler(String(url), options),
    { preconnect: fetch.preconnect },
  ));
  restore = () => fetcher.mockRestore();
  return fetcher;
}

test('Grok renews an expired login once for concurrent quota reads and saves rotated tokens without losing sibling logins', async () => {
  const sibling = { key: 'fixture-sibling-key' };
  await save({ [scope]: expired, sibling });
  let refreshes = 0;
  mockFetch(async (url, options) => {
    expect(options?.redirect).toBe('error');
    if (url === tokenEndpoint) {
      refreshes++;
      expect(options?.method).toBe('POST');
      expect(options?.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
      expect(Object.fromEntries(new URLSearchParams(String(options?.body)))).toEqual({
        grant_type: 'refresh_token', refresh_token: expired.refresh_token, client_id: expired.oidc_client_id,
        principal_type: 'team', principal_id: 'fixture-team',
      });
      await save({ [scope]: expired, sibling, addedByCli: { key: 'fixture-added-key' } });
      return Response.json({ access_token: 'fixture-renewed-access', refresh_token: 'fixture-rotated-refresh', expires_in: 3600 });
    }
    expect(url).toBe(billing);
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-renewed-access', 'x-xai-token-auth': 'xai-grok-cli' });
    return report();
  });
  const results = await Promise.all([readExtraQuota(core, account), readExtraQuota(core, account)]);
  expect(results.map((windows) => windows[0]?.usedPercent)).toEqual([25, 25]);
  expect(refreshes).toBe(1);
  const auth = await load();
  expect(Date.parse(auth[scope].expires_at)).toBeGreaterThan(Date.now());
  expect(auth[scope]).toMatchObject({ ...expired, key: 'fixture-renewed-access', refresh_token: 'fixture-rotated-refresh', expires_at: expect.any(String) });
  expect(auth.sibling).toEqual(sibling);
  expect(auth.addedByCli).toEqual({ key: 'fixture-added-key' });
  expect(await readdir(directory)).toEqual(['auth.json']);
});

test('Grok uses a current subscription login without refreshing and accepts legacy logins with no expiry', async () => {
  const fetcher = mockFetch(async (url, options) => {
    expect(url).toBe(billing);
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-current-access' });
    return report();
  });
  await save({ 'xai::api_key': { key: 'fixture-api-key' }, [scope]: fresh });
  expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(25);
  await save({ 'https://accounts.x.ai/sign-in': { key: fresh.key } });
  expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(25);
  expect(fetcher).toHaveBeenCalledTimes(2);
});

test('Grok retries a rejected access token once and keeps a refresh token when the server does not rotate it', async () => {
  await save({ [scope]: fresh, 'https://accounts.x.ai/sign-in': { key: 'fixture-other-account' } });
  let reads = 0;
  const fetcher = mockFetch(async (url, options) => {
    if (url === tokenEndpoint) return Response.json({ access_token: 'fixture-renewed-access', expires_in: 3600 });
    expect(url).toBe(billing);
    reads++;
    if (reads === 1) return new Response(null, { status: 401 });
    expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-renewed-access' });
    return report();
  });
  expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(25);
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect((await load())[scope].refresh_token).toBe(expired.refresh_token);
});

test('Grok stops after one rejected retry and does not refresh subscription access denials', async () => {
  let status = 401;
  const fetcher = mockFetch(async (url) => url === tokenEndpoint
    ? Response.json({ access_token: 'fixture-renewed-access', expires_in: 3600 })
    : new Response(null, { status }));
  await save({ [scope]: fresh });
  await expect(readExtraQuota(core, account)).rejects.toThrow('login expired or has no subscription access');
  expect(fetcher).toHaveBeenCalledTimes(3);
  fetcher.mockClear();
  status = 403;
  await save({ [scope]: fresh });
  await expect(readExtraQuota(core, account)).rejects.toThrow('login expired or has no subscription access');
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('Grok refuses missing, malformed and foreign refresh credentials without sending any token', async () => {
  const fetcher = mockFetch(async () => { throw new Error('unexpected request'); });
  for (const login of [
    { ...expired, refresh_token: undefined }, { ...expired, key: '' },
    { ...expired, oidc_issuer: 'https://untrusted.example' }, { ...expired, oidc_client_id: '' },
    { ...expired, expires_at: 'invalid' },
  ]) {
    await save({ [scope]: login });
    await expect(readExtraQuota(core, account)).rejects.toThrow('Grok login');
  }
  expect(fetcher).not.toHaveBeenCalled();
});

test('Grok keeps credentials on renewal failures and never reports server bodies or tokens', async () => {
  const original = { [scope]: expired };
  let response = new Response('fixture-secret-response', { status: 400 });
  mockFetch(async (url) => { expect(url).toBe(tokenEndpoint); return response; });
  for (const failure of [response, new Response('fixture-secret-response', { status: 503 }), Response.json({ access_token: '' }), Response.json({ access_token: 'fixture-token', expires_in: -1 })]) {
    response = failure;
    await save(original);
    const error = await readExtraQuota(core, account).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('Grok login renewal');
    expect(String(error)).not.toContain('fixture-');
    expect(await load()).toEqual(original);
  }
});

test('Grok preserves a login replaced by the CLI during renewal', async () => {
  let replacement = fresh;
  mockFetch(async (url, options) => {
    if (url === tokenEndpoint) {
      await save({ [scope]: replacement });
      return Response.json({ access_token: 'fixture-obsolete-access', refresh_token: 'fixture-obsolete-refresh', expires_in: 3600 });
    }
    expect(url).toBe(billing);
    expect(options?.headers).toMatchObject({ Authorization: `Bearer ${replacement.key}` });
    return report();
  });
  for (const changed of [fresh, { ...fresh, key: expired.key, create_time: '2026-01-01T00:00:00Z' }]) {
    replacement = changed;
    await save({ [scope]: expired });
    expect((await readExtraQuota(core, account))[0]?.usedPercent).toBe(25);
    expect((await load())[scope]).toEqual(replacement);
  }
});
