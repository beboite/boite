import { expect, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { test } from '../../test/fake-client';
import { RpcFailure } from '../client';
import { normalizeUrl } from '../browser-bridge';
import { policySearch } from '../policy';
import { FAKE_GATED_METHODS, policyFixture } from './policy';
import source from '../../../../core/src/policy-gate.ts?raw';

test('the fake gates the methods the core gates, no more and no fewer', () => {
  const rules = source.slice(source.indexOf('const RULES'), source.indexOf('export const GATED_METHODS'));
  const core = [...rules.matchAll(/^ {2}'([\w.]+)':/gm)].map((match) => match[1]);
  expect(core.length).toBeGreaterThan(30);
  expect([...FAKE_GATED_METHODS].sort()).toEqual(core.sort());
});

test('a gated method refuses with the core code, sentence and data', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, policy: policyFixture('managed') });
  await expect(client.call('push.test', {})).rejects.toMatchObject({
    code: RpcErrorCode.Refused,
    message: "Push notifications: blocked by your organization's policy, key network.push in /etc/boite/policy.json",
    data: { policy: 'network.push', file: '/etc/boite/policy.json' },
  });
});

test('the address bar searches where the policy says, the default otherwise', () => {
  const search = policySearch(policyFixture('managed'));
  expect(search).toBe('https://search.example.com/?q={query}');
  expect(normalizeUrl('quarterly report', search)).toBe('https://search.example.com/?q=quarterly%20report');
  expect(normalizeUrl('example.com/docs', search)).toBe('https://example.com/docs');
  expect(normalizeUrl('quarterly report', policySearch(policyFixture(null)))).toBe('https://www.google.com/search?q=quarterly%20report');
});

test('the store follows a policy file edited while connected', async ({ ready }) => {
  const { store, client } = await ready({ delayMs: 0, policy: policyFixture(null) });
  await vi.waitFor(() => expect(store.policy?.present).toBe(false));
  client.changePolicy(policyFixture('managed'));
  await vi.waitFor(() => expect(store.policy?.locked).toContain('network.push'));
  // The core lists its providers again after a change: the one the file now denies is off, saying why.
  await vi.waitFor(() => expect(store.providers.find((provider) => provider.id === 'grok')).toMatchObject({ enabled: false, policy: { policy: 'providers.deny' } }));
  expect(store.settings?.autoInstallUpdates).toBe(false);
});

test('a core without the policy method leaves nothing locked', async ({ createStore }) => {
  const { store, client } = createStore({ delayMs: 0, policy: policyFixture('managed') });
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => method === 'policy.get'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method policy.get' }))
    : call(method as never, params as never)) as typeof client.call);
  store.attach(client);
  await store.connect();
  await vi.waitFor(() => expect(store.providers.length).toBeGreaterThan(0));
  expect(store.policy).toBeNull();
});
