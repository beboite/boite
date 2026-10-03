import { afterEach, expect, test } from 'bun:test';
import type { SubscriptionProxy } from '@boite/contracts';
import { checkSettingsPatch } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { probedModelsOf } from '../src/drivers/index.ts';
import { subscriptionProxyCodexArgs, subscriptionProxyEnv } from '../src/subscription-proxy.ts';
import { startTestCore, type TestCore } from './harness.ts';

let harness: TestCore | undefined;
let gateway: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { gateway?.stop(true); gateway = undefined; await harness?.stop(); harness = undefined; });

function config(baseUrl: string, kind: SubscriptionProxy['kind'] = 'douane'): SubscriptionProxy {
  return { enabled: true, kind, baseUrl, dashboardUrl: `${baseUrl.replace(/\/v1\/?$/, '')}/admin/#quotas` };
}

test('proxy URLs reject credential channels and retain the dashboard route', () => {
  for (const baseUrl of ['https://name:password@proxy.test', 'https://proxy.test?key=secret', 'file:///C:/proxy', 'https://proxy.test/#token']) {
    expect(checkSettingsPatch({ subscriptionProxy: config(baseUrl) }).ok).toBe(false);
  }
  expect(checkSettingsPatch({ subscriptionProxy: config('http://127.0.0.1:8317/v1/') })).toMatchObject({ ok: true, patch: { subscriptionProxy: { baseUrl: 'http://127.0.0.1:8317/v1', dashboardUrl: 'http://127.0.0.1:8317/admin/#quotas' } } });
  expect(checkSettingsPatch({ subscriptionProxy: config('http://gateway.lan:8787') }).ok).toBe(true);
});

test('configuration and private key roll back together without leaking to events, snapshots, errors or logs', async () => {
  const previous = config('http://gateway.lan:8787');
  const next = config('https://gateway.test');
  const oldKey = 'previous-private-proxy-token', newKey = 'replacement-private-proxy-token';
  harness = await startTestCore({ settings: { subscriptionProxy: previous } });
  const owner = await harness.connect();
  await owner.call('subscriptionProxy.key', { key: oldKey });
  const broadcasts: unknown[] = [];
  const errors: unknown[] = [];
  const off = owner.on('settings.updated', value => broadcasts.push(value));
  const db = harness.core.journal.db;
  const envKey = () => subscriptionProxyEnv(harness!.core, harness!.core.providers.require('claude')).ANTHROPIC_AUTH_TOKEN;
  const events = harness.core.journal.countEvents('settings.changed');
  try {
    for (const [name, operation, condition, key] of [
      ['config', 'INSERT', "NEW.key = 'settings'", newKey],
      ['config_clear', 'INSERT', "NEW.key = 'settings'", null],
      ['key', 'INSERT', "NEW.key = 'subscription-proxy-key'", newKey],
      ['clear', 'DELETE', "OLD.key = 'subscription-proxy-key'", null],
    ] as const) {
      db.exec(`CREATE TRIGGER refuse_proxy_${name} BEFORE ${operation} ON settings WHEN ${condition} BEGIN SELECT RAISE(ABORT, 'forced persistence refusal'); END`);
      let failure: Error | undefined;
      try { await owner.call('subscriptionProxy.configure', { subscriptionProxy: next, key }); }
      catch (error) { failure = error as Error; errors.push({ ...error as object, message: failure.message }); }
      expect(failure?.message).toBe('Subscription proxy configuration could not be saved');
      expect((await owner.call('settings.get', {})).subscriptionProxy).toEqual(previous);
      expect(envKey()).toBe(oldKey);
      expect(harness.core.journal.countEvents('settings.changed')).toBe(events);
      expect(broadcasts).toEqual([]);
      db.exec(`DROP TRIGGER refuse_proxy_${name}`);
    }
    const saved = await owner.call('subscriptionProxy.configure', { subscriptionProxy: next, key: newKey });
    expect(saved.subscriptionProxy).toEqual(next);
    expect(envKey()).toBe(newKey);
    await owner.call('subscriptionProxy.configure', { subscriptionProxy: next });
    expect(envKey()).toBe(newKey);
    await expect(owner.call('subscriptionProxy.configure', { subscriptionProxy: next, key: `${newKey}\n` })).rejects.toThrow('without whitespace');
    expect(envKey()).toBe(newKey);
    const publicData = JSON.stringify({ saved, settings: await owner.call('settings.get', {}), broadcasts, errors,
      events: db.query('SELECT payload FROM events').all(), logs: await owner.call('core.logs', {}) });
    for (const key of [oldKey, newKey]) expect(publicData).not.toContain(key);
    await owner.call('subscriptionProxy.configure', { subscriptionProxy: next, key: null });
    expect(envKey()).toBe('boite-subscription-proxy');
  } finally { off(); }
});

test('real RPC discovers gateway models, separates the key and restores native accounts when disabled', async () => {
  const auth: string[] = [], paths: string[] = [];
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    auth.push(request.headers.get('authorization') ?? ''); paths.push(new URL(request.url).pathname);
    return Response.json({ data: [
      { id: 'pooled-claude', name: 'Claude pool', supported_endpoint_types: ['anthropic'] },
      { id: 'codex/gpt-6.1-sol', name: 'Codex pool', supported_endpoint_types: ['openai-response'],
        thinking: { levels: ['low', 'high', 'xhigh'] }, defaultReasoningEffort: 'xhigh' },
      { id: 'pooled-claude', supported_endpoint_types: ['anthropic'] },
    ] });
  } });
  harness = await startTestCore();
  const owner = await harness.connect();
  const claude = await owner.call('accounts.add', { providerId: 'claude', label: 'Proxy Claude' });
  const codex = await owner.call('accounts.add', { providerId: 'codex', label: 'Proxy Codex' });
  // Native login detection differs by platform; disabling restores the original status.
  const nativeClaudeStatus = harness.core.accounts.require(claude.id).status;
  const key = 'subscription-proxy-test-token';
  const proxy = config(`http://127.0.0.1:${gateway.port}/v1`);
  const saved = await owner.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key });
  expect(JSON.stringify(saved)).not.toContain(key);
  expect(JSON.stringify(await owner.call('settings.get', {}))).not.toContain(key);
  expect(harness.core.accounts.require(claude.id).status).toBe('ok');
  const a = await owner.call('providers.probe', { providerId: 'claude', accountId: claude.id });
  const b = await owner.call('providers.probe', { providerId: 'codex', accountId: codex.id });
  expect(a.models).toEqual([{ id: 'pooled-claude', name: 'Claude pool', default: true }]);
  expect(b.models).toEqual([{ id: 'codex/gpt-6.1-sol', name: 'Codex pool', default: true,
    effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }], default: 'xhigh' } }]);
  expect(paths).toEqual(['/v1/models', '/v1/models']);
  expect(auth).toEqual([`Bearer ${key}`, `Bearer ${key}`]);
  const claudeEnv = subscriptionProxyEnv(harness.core, harness.core.providers.require('claude'));
  expect(claudeEnv.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${gateway.port}`);
  expect(claudeEnv.ANTHROPIC_AUTH_TOKEN).toBe(key);
  expect(claudeEnv.ANTHROPIC_API_KEY).toBe('');
  const codexEnv = subscriptionProxyEnv(harness.core, harness.core.providers.require('codex'));
  const args = subscriptionProxyCodexArgs(['app-server'], codexEnv);
  expect(args.join(' ')).not.toContain(key);
  expect(args).toContain('model_providers.boite_subscription_proxy.wire_api="responses"');
  expect(args).toContain('model_providers.boite_subscription_proxy.supports_websockets=true');
  const quotas = await owner.call('quotas.list', { refresh: true });
  expect(quotas.find(row => row.accountId === claude.id)?.status).toBe('unsupported');
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    expect((await phone.call('settings.get', {})).subscriptionProxy).toEqual(proxy);
    await expect(phone.call('subscriptionProxy.key', { key: null })).rejects.toThrow('owner');
    await expect(phone.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: null })).rejects.toThrow('owner');
    expect((await phone.call('providers.probe', { providerId: 'codex', accountId: codex.id })).models).toEqual(b.models);
  } finally { phone.close(); }
  await owner.call('settings.set', { subscriptionProxy: { ...proxy, enabled: false } });
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('codex'))).toEqual({});
  expect(probedModelsOf('codex-appserver', 'codex', codex.id)).toBeNull();
  expect(harness.core.accounts.require(claude.id).status).toBe(nativeClaudeStatus);
});

test('legacy CLIProxy catalogs select native families and malformed gateway errors cannot echo the key', async () => {
  let fail = false;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return fail ? new Response('private-token-in-body', { status: 401 }) : Response.json({ data: [
      { id: 'claude/claude-sonnet-4-5' }, { id: 'codex/gpt-5.4', display_name: 'Codex GPT 5.4',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More reasoning' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'xhigh' }] },
      { id: 'gemini-3-pro' },
    ] });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}`, 'cliproxyapi') } });
  const owner = await harness.connect();
  const account = await owner.call('accounts.add', { providerId: 'codex', label: 'Gateway' });
  expect((await owner.call('providers.probe', { providerId: 'codex', accountId: account.id })).models).toEqual([{ id: 'codex/gpt-5.4', name: 'Codex GPT 5.4', default: true,
    effort: { levels: [{ id: 'high', label: 'High', description: 'More reasoning' }, { id: 'xhigh', label: 'Extra high' }], default: 'high' } }]);
  fail = true;
  await expect(owner.call('providers.probe', { providerId: 'codex', accountId: account.id, refresh: true })).rejects.toThrow('HTTP 401');
  expect(JSON.stringify(await owner.call('core.logs', {}))).not.toContain('private-token-in-body');
});
