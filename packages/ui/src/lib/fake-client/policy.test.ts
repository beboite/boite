import { expect, vi } from 'vitest';
import { RpcErrorCode } from '@boite/contracts';
import { test } from '../../test/fake-client';
import { RpcFailure } from '../client';
import { normalizeUrl } from '../browser-bridge';
import { lockedBy, policySearch } from '../policy';
import { FAKE_GATED_METHODS, fakePolicy, policyFixture } from './policy';
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

test('a first launch lists the denied provider off, and dictation refuses as the core does', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, uninstalled: true, policy: policyFixture('managed') });
  expect((await client.call('providers.list', {})).loaded.find((provider) => provider.id === 'grok')).toMatchObject({ enabled: false, policy: { policy: 'providers.deny' } });
  const closed = await ready({ delayMs: 0, policy: policyFixture('closed') });
  await expect(closed.client.call('speech.transcribe', { requestId: 'r1', revision: 0, audio: '' } as never)).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { policy: 'dictation' } });
});

test('adding a local ACP provider applies policy before returning, notifying or creating its default account', async ({ createClient }) => {
  const client = await createClient({ delayMs: 0, policy: fakePolicy({ providers: { allow: [] } }) });
  const updated = vi.fn();
  client.on('providers.updated', updated);
  const result = await client.call('providers.addLocal', { name: 'Policy ACP', command: 'policy-agent', args: [], env: {} });
  const blocked = { id: result.providerId, enabled: false, policy: { policy: 'providers.allow', file: '/etc/boite/policy.json' } };
  expect(result.loaded.find(provider => provider.id === result.providerId)).toMatchObject(blocked);
  expect(updated).toHaveBeenCalledExactlyOnceWith({ loaded: expect.arrayContaining([expect.objectContaining(blocked)]), rejected: [] });
  expect((await client.call('accounts.list', {})).filter(account => account.providerId === result.providerId)).toEqual([]);
  expect((await client.call('providers.list', {})).loaded).toEqual(result.loaded);
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

test('removing a policy restores user settings, telemetry and provider choices', async ({ ready }) => {
  const { client, store } = await ready({ delayMs: 0, policy: fakePolicy(null) });
  const proxy = { enabled: true, kind: 'douane' as const, baseUrl: 'https://gateway.example/v1', dashboardUrl: 'https://gateway.example/admin/' };
  await client.call('settings.set', { listenOnLan: true, autoInstallUpdates: true, autoUpdateHarnesses: true, groupThreads: true, groupBots: true, subscriptionProxy: proxy });
  await client.call('telemetry.configure', { mode: 'enhanced' });
  await client.call('providers.setEnabled', { providerId: 'pi', enabled: false });
  client.changePolicy(fakePolicy({ ...policyFixture('managed').values, analytics: 'off' }));
  expect(await client.call('settings.get', {})).toMatchObject({ listenOnLan: false, autoInstallUpdates: false, autoUpdateHarnesses: false, groupThreads: false, groupBots: false, subscriptionProxy: { enabled: false } });
  expect((await client.call('telemetry.state', {})).mode).toBe('off');
  expect((await client.call('providers.list', {})).loaded.find(provider => provider.id === 'grok')).toMatchObject({ enabled: false, policy: { policy: 'providers.deny' } });
  // Repeated reads and a replacement policy must not turn the imposed values into saved choices.
  client.changePolicy(fakePolicy({ ...policyFixture('managed').values, analytics: 'basic' }));
  expect((await client.call('telemetry.state', {})).mode).toBe('basic');
  client.changePolicy(fakePolicy(null));
  expect(await client.call('settings.get', {})).toMatchObject({ listenOnLan: true, autoInstallUpdates: true, autoUpdateHarnesses: true, groupThreads: true, groupBots: true, subscriptionProxy: proxy });
  expect((await client.call('telemetry.state', {})).mode).toBe('enhanced');
  const providers = (await client.call('providers.list', {})).loaded;
  expect(providers.find(provider => provider.id === 'grok')).toMatchObject({ enabled: true });
  expect(providers.find(provider => provider.id === 'grok')).not.toHaveProperty('policy');
  expect(providers.find(provider => provider.id === 'pi')).toMatchObject({ enabled: false });
  await vi.waitFor(() => expect(store.settings?.subscriptionProxy?.enabled).toBe(true));
});

test('edits under a policy keep unrelated choices and preserve held switches', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, policy: fakePolicy(null) });
  const proxy = { enabled: true, kind: 'douane' as const, baseUrl: 'https://old.example/v1', dashboardUrl: 'https://old.example/admin/' };
  await client.call('settings.set', { listenOnLan: true, subscriptionProxy: proxy });
  await client.call('telemetry.configure', { mode: 'enhanced' });
  client.changePolicy(policyFixture('managed'));
  await client.call('settings.set', { listenOnLan: false, warmProcessMinutes: 8 });
  const updatedProxy = { ...proxy, enabled: false, baseUrl: 'https://new.example/v1', dashboardUrl: 'https://new.example/admin/' };
  await client.call('subscriptionProxy.configure', { subscriptionProxy: updatedProxy });
  await client.call('telemetry.configure', { mode: 'off' });
  client.changePolicy(fakePolicy(null));
  expect(await client.call('settings.get', {})).toMatchObject({ listenOnLan: true, warmProcessMinutes: 8, subscriptionProxy: { ...updatedProxy, enabled: true } });
  expect((await client.call('telemetry.state', {})).mode).toBe('off');
});

test('the gateway allow list also guards moves to a disabled saved proxy', async ({ ready }) => {
  const { client } = await ready({ delayMs: 0, policy: fakePolicy({ gateway: { allowedBaseUrls: ['https://corp.example'] } }) });
  await client.call('settings.set', { subscriptionProxy: { enabled: false, kind: 'douane', baseUrl: 'http://127.0.0.1:18787/v1', dashboardUrl: 'http://127.0.0.1:18787/admin/' } });
  await expect(client.call('subscriptionProxy.movePlan', {})).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { policy: 'gateway.allowedBaseUrls' } });
  await expect(client.call('subscriptionProxy.move', { ids: ['fixture:login'] })).rejects.toMatchObject({ code: RpcErrorCode.Refused, data: { policy: 'gateway.allowedBaseUrls' } });
});

test('a core without the policy method leaves nothing locked', async ({ createStore }) => {
  const { store, client } = createStore({ delayMs: 0, policy: policyFixture(null) });
  const call = client.call.bind(client);
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => method === 'policy.get'
    ? Promise.reject(new RpcFailure({ code: RpcErrorCode.MethodNotFound, message: 'unknown method policy.get' }))
    : call(method as never, params as never)) as typeof client.call);
  store.attach(client);
  await store.connect();
  await vi.waitFor(() => expect(store.providers.length).toBeGreaterThan(0));
  expect(store.policy).toBeNull();
  expect(store.providers.some((provider) => provider.policy !== undefined)).toBe(false);
  expect(lockedBy(store.policy, 'network.push')).toBeNull();
});
