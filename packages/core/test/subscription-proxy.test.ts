import { afterEach, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SubscriptionProxy } from '@boite/contracts';
import { checkSettingsPatch } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { probedModelsOf } from '../src/drivers/index.ts';
import { childEnv } from '../src/drivers/claude/query.ts';
import { agentEnv } from '../src/providers/resolve.ts';
import { mergeProxyModels, readSubscriptionProxyModels, subscriptionProxyCodexArgs, subscriptionProxyEnv } from '../src/subscription-proxy.ts';
import { startTestCore, type TestCore } from './harness.ts';
import { thrown } from './settle.ts';

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

test('Muse uses only an observed native Meta subscription and restores its own login otherwise', async () => {
  let meta = false;
  let routes: 'missing' | 'html' | 'error' | 'catalog-only' | 'native' = 'missing';
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/muse-code/models') {
      if (routes === 'missing') return new Response('Missing', { status: 404 });
      if (routes === 'html') return new Response('<html>Dashboard</html>');
      if (routes === 'error') return new Response('Temporary failure', { status: 503 });
      return Response.json({ data: [{ id: 'muse-spark-1.3', metadata: { 'muse-code': { name: 'Muse Spark 1.3' } } }] });
    }
    if (path === '/muse-code/responses') return new Response(null, { status: routes === 'native' ? 405 : 404, headers: routes === 'native' ? { Allow: 'POST' } : {} });
    return Response.json({ providers: [{ provider: meta ? 'meta' : 'opencode_go', name: 'Muse', entries: [
      { id: 'seat', label: 'Subscription', accounts: 1, status: 'ready', windows: [], credits: [] },
    ] }] });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}/v1`) } });
  const owner = await harness.connect();
  const account = await owner.call('accounts.add', { providerId: 'muse', label: 'Native Muse' });
  const provider = harness.core.providers.require('muse');
  const nativeEnv = harness.core.accounts.accountEnv(account, provider);
  expect(account.status).toBe('unauthenticated');
  await owner.call('subscriptionProxy.quotas', { refresh: true });
  expect(subscriptionProxyEnv(harness.core, provider)).toEqual({});
  meta = true;
  for (const mode of ['missing', 'html', 'error', 'catalog-only'] as const) {
    routes = mode;
    await owner.call('subscriptionProxy.quotas', { refresh: true });
    expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
    expect(subscriptionProxyEnv(harness.core, provider)).toEqual({});
  }
  routes = 'native';
  await owner.call('subscriptionProxy.quotas', { refresh: true });
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('ok');
  const env = harness.core.accounts.accountEnv(account, provider);
  expect(env.META_API_KEY).toBe('boite-subscription-proxy');
  expect(env.XDG_CONFIG_HOME).not.toBe(nativeEnv.XDG_CONFIG_HOME);
  const settings = JSON.parse(await Bun.file(join(env.XDG_CONFIG_HOME!, 'muse', 'settings.json')).text());
  expect(settings).toEqual({ schema_version: 1, endpoint_transport: { base_url: `http://127.0.0.1:${gateway.port}/muse-code`, auth: 'bearer' } });
  expect(JSON.stringify(settings)).not.toContain(env.META_API_KEY!);
  expect(agentEnv(provider, env).META_API_KEY).toBe(env.META_API_KEY);
  expect(existsSync(join(account.isolationDir!, 'muse', 'auth.json'))).toBe(false);
  expect(await readSubscriptionProxyModels(harness.core, provider)).toBeNull();
  meta = false;
  await owner.call('subscriptionProxy.quotas', { refresh: true });
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  expect(harness.core.accounts.accountEnv(account, provider)).toEqual(nativeEnv);
  meta = true;
  await owner.call('subscriptionProxy.quotas', { refresh: true });
  await owner.call('subscriptionProxy.setEnabled', { enabled: false });
  expect(harness.core.accounts.accountEnv(account, provider)).toEqual(nativeEnv);
});

test('the first Muse probe discovers Meta before capturing its account revision', async () => {
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/muse-code/models') return Response.json({ data: [{ id: 'muse-spark-1.3', metadata: { 'muse-code': { name: 'Muse Spark 1.3' } } }] });
    if (new URL(request.url).pathname === '/muse-code/responses') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    return Response.json({ providers: [{ provider: 'meta', entries: [
      { id: 'native', label: 'Native subscription', status: 'ready', windows: [], credits: [] },
    ] }] });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}/v1`) } });
  const owner = await harness.connect();
  const provider = harness.core.providers.require('muse');
  for (const profile of Object.values(provider.profiles)) {
    profile.executable = [{ kind: 'file', value: process.execPath }];
    profile.launch = { args: [join(import.meta.dir, 'fixtures', 'muse-server.ts')] };
  }
  const account = await owner.call('accounts.add', { providerId: 'muse', label: 'Gateway Muse' });
  expect(account.status).toBe('unauthenticated');
  const { models } = await owner.call('providers.probe', { providerId: 'muse', accountId: account.id });
  expect(models.some(model => model.id === 'muse-spark-1.3')).toBe(true);
  expect(harness.core.accounts.require(account.id).status).toBe('ok');
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
    expect(await thrown(owner.call('subscriptionProxy.configure', { subscriptionProxy: next, key: `${newKey}\n` }))).toThrow('without whitespace');
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
  // A switch with nothing behind it would route agents to an empty address.
  expect(await thrown(owner.call('subscriptionProxy.setEnabled', { enabled: true }))).toThrow('no subscription proxy is configured');
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
  // Through the gateway, Claude Code keeps its subscription behavior: tool search, 1h cache, fast mode.
  expect(claudeEnv).toMatchObject({ _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1', CLAUDE_CODE_PROMPT_CACHE_TTL: '1h', CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1' });
  expect(childEnv(claudeEnv).CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  const codexEnv = subscriptionProxyEnv(harness.core, harness.core.providers.require('codex'));
  const args = subscriptionProxyCodexArgs(['app-server'], codexEnv);
  expect(args.join(' ')).not.toContain(key);
  expect(args).toContain('model_providers.boite_subscription_proxy.wire_api="responses"');
  expect(args).toContain('model_providers.boite_subscription_proxy.supports_websockets=true');
  // Douane answers for the limits; this machine's own logins are not listed beside it.
  const quotas = await owner.call('quotas.list', { refresh: true });
  expect(quotas.some(row => row.accountId === claude.id || row.accountId === codex.id)).toBe(false);
  expect(paths).toContain('/v1/quotas');
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    expect((await phone.call('settings.get', {})).subscriptionProxy).toEqual(proxy);
    expect(await thrown(phone.call('subscriptionProxy.key', { key: null }))).toThrow('owner');
    expect(await thrown(phone.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: null }))).toThrow('owner');
    expect((await phone.call('providers.probe', { providerId: 'codex', accountId: codex.id })).models).toEqual(b.models);
    // The phone switches the owner's gateway off, and only that: the address and key stay.
    expect(await thrown(phone.call('subscriptionProxy.setEnabled', { enabled: 'no' as unknown as boolean }))).toThrow('boolean');
    expect((await phone.call('subscriptionProxy.setEnabled', { enabled: false })).subscriptionProxy).toEqual({ ...proxy, enabled: false });
  } finally { phone.close(); }
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('codex'))).toEqual({});
  expect(probedModelsOf('codex-appserver', 'codex', codex.id)).toBeNull();
  expect(harness.core.accounts.require(claude.id).status).toBe(nativeClaudeStatus);
  expect((await owner.call('quotas.list', {})).some(row => row.accountId === claude.id)).toBe(true);
  // Back on with the key the owner saved.
  await owner.call('subscriptionProxy.setEnabled', { enabled: true });
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('claude')).ANTHROPIC_AUTH_TOKEN).toBe(key);
});

test('a gateway that translates every model keeps proprietary models in their own harness', async () => {
  const anyApi = ['anthropic', 'openai', 'openai-response'];
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ data: ['claude/claude-opus-5-5', 'codex/gpt-6-sol', 'codex/codex-auto-review', 'antigravity/claude-sonnet-5-5-high',
      'antigravity/gemini-3-flash', 'antigravity/gpt-oss-120b-medium', 'xai/grok-5', 'muse/muse-code', 'kimi/kimi-k2',
      'qwen/qwen3-gptq', 'codex/o5', 'codex/computer-use-preview', 'claude/default', 'claude/kimi-k2', 'codex/qwen3-coder',
      'meta/llama-4-maverick']
      .map(id => ({ id, supported_endpoint_types: anyApi })) });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}/v1`) } });
  const owner = await harness.connect();
  const claude = await owner.call('accounts.add', { providerId: 'claude', label: 'Gateway Claude' });
  const codex = await owner.call('accounts.add', { providerId: 'codex', label: 'Gateway Codex' });
  const ids = async (providerId: 'claude' | 'codex', accountId: string) =>
    (await owner.call('providers.probe', { providerId, accountId })).models.map(model => model.id);
  expect(await ids('claude', claude.id)).toEqual(['claude/claude-opus-5-5', 'antigravity/claude-sonnet-5-5-high', 'antigravity/gemini-3-flash',
    'antigravity/gpt-oss-120b-medium', 'kimi/kimi-k2', 'qwen/qwen3-gptq', 'claude/default', 'claude/kimi-k2', 'codex/qwen3-coder',
    'meta/llama-4-maverick']);
  expect(await ids('codex', codex.id)).toEqual(['codex/gpt-6-sol', 'codex/codex-auto-review', 'antigravity/gemini-3-flash',
    'antigravity/gpt-oss-120b-medium', 'kimi/kimi-k2', 'qwen/qwen3-gptq', 'codex/o5', 'codex/computer-use-preview', 'claude/kimi-k2',
    'codex/qwen3-coder', 'meta/llama-4-maverick']);
});

for (const providerId of ['opencode', 'opencode-v2'] as const) test(`${providerId} takes the gateway with its own config schema and advertised Antigravity Claude routes`, async () => {
  const anyApi = ['anthropic', 'openai', 'openai-response'];
  const sent: { key: string | null } = { key: null };
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    sent.key = request.headers.get('authorization');
    return Response.json({ data: [
      ...['claude/claude-opus-5-5', 'codex/gpt-6-sol', 'antigravity/claude-sonnet-5-5-high', 'antigravity/gemini-3-flash',
        'antigravity/gpt-oss-120b-medium', 'xai/grok-5', 'opencode_go/grok-code-fast', 'muse/muse-code', 'opencode_go/kimi-k3',
        'codex/o5', 'claude/default', 'codex/qwen3-coder'].map(id => ({ id, name: `Name of ${id}`, supported_endpoint_types: anyApi })),
      // A model the gateway only answers over Messages has no Chat Completions route for OpenCode to call.
      { id: 'kimi/messages-only', supported_endpoint_types: ['anthropic'] },
      { id: 'antigravity/claude-messages-only', supported_endpoint_types: ['anthropic'] },
      // Legacy catalogs remain usable, but cannot establish a cross-harness Claude route.
      { id: 'antigravity/claude-unadvertised' },
      { id: 'antigravity/gemini-legacy' },
      // An id that could not be a key of OpenCode's configuration is left out rather than written into it.
      { id: 'bad id"}', supported_endpoint_types: anyApi },
    ] });
  } });
  const url = `http://127.0.0.1:${gateway.port}/v1`;
  harness = await startTestCore({ settings: { subscriptionProxy: config(url) } });
  const owner = await harness.connect();
  await owner.call('subscriptionProxy.key', { key: 'gateway-key' });
  await owner.call('providers.setEnabled', { providerId, enabled: true });
  // The gateway is the login: no sign-in of OpenCode's own is asked for.
  const account = await owner.call('accounts.add', { providerId, label: 'Gateway OpenCode' });
  expect(account.status).toBe('ok');

  // No OpenCode on a test machine: its own list is missing, the gateway's stands alone.
  const { models } = await owner.call('providers.probe', { providerId, accountId: account.id });
  expect(sent.key).toBe('Bearer gateway-key');
  // Only explicitly advertised Antigravity Claude routes cross the native-harness boundary.
  expect(models.map(model => model.id)).toEqual(['douane/antigravity/claude-sonnet-5-5-high', 'douane/antigravity/gemini-3-flash', 'douane/antigravity/gpt-oss-120b-medium',
    'douane/muse/muse-code', 'douane/opencode_go/kimi-k3', 'douane/codex/qwen3-coder', 'douane/antigravity/gemini-legacy']);
  expect(models[0]).toEqual({ id: 'douane/antigravity/claude-sonnet-5-5-high', name: 'Name of antigravity/claude-sonnet-5-5-high' });

  const provider = harness.core.providers.require(providerId);
  const collection = providerId === 'opencode' ? 'provider' : 'providers';
  const original = JSON.parse(Object.values(provider.profiles)[0]!.env!['OPENCODE_CONFIG_CONTENT']!);
  expect(original).toEqual(providerId === 'opencode'
    ? { permission: { task: 'deny' } }
    : { permissions: [{ action: 'subagent', resource: '*', effect: 'deny' }] });
  const base = { ...original, [collection]: { existing: { name: 'Existing provider' } } };
  for (const profile of Object.values(provider.profiles)) profile.env = { ...profile.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(base) };
  const env = subscriptionProxyEnv(harness.core, provider);
  expect(Object.keys(env).sort()).toEqual(['BOITE_SUBSCRIPTION_PROXY_KEY', 'BOITE_SUBSCRIPTION_PROXY_PREFIX', 'OPENCODE_CONFIG_CONTENT']);
  expect(env['BOITE_SUBSCRIPTION_PROXY_KEY']).toBe('gateway-key');
  expect(env['BOITE_SUBSCRIPTION_PROXY_PREFIX']).toBe('douane/');
  // The key is named, never written: OpenCode reads it from its environment.
  expect(env['OPENCODE_CONFIG_CONTENT']).not.toContain('gateway-key');
  const catalog = {
    'antigravity/claude-sonnet-5-5-high': { name: 'Name of antigravity/claude-sonnet-5-5-high' },
    'antigravity/gemini-3-flash': { name: 'Name of antigravity/gemini-3-flash' },
    'antigravity/gpt-oss-120b-medium': { name: 'Name of antigravity/gpt-oss-120b-medium' },
    'muse/muse-code': { name: 'Name of muse/muse-code' },
    'opencode_go/kimi-k3': { name: 'Name of opencode_go/kimi-k3' },
    'codex/qwen3-coder': { name: 'Name of codex/qwen3-coder' },
    'antigravity/gemini-legacy': { name: 'antigravity/gemini-legacy' },
  };
  const integration = providerId === 'opencode' ? {
    npm: '@ai-sdk/openai-compatible', name: 'Douane',
    options: { baseURL: url, apiKey: '{env:BOITE_SUBSCRIPTION_PROXY_KEY}' }, models: catalog,
  } : {
    package: '@opencode/ai/providers/openai-compatible', name: 'Douane',
    settings: { baseURL: url }, env: ['BOITE_SUBSCRIPTION_PROXY_KEY'], models: catalog,
  };
  expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
    ...base, [collection]: { existing: { name: 'Existing provider' }, douane: integration },
  });
  // The account's whole environment carries it, over the descriptor's own inline configuration.
  expect(harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider)['OPENCODE_CONFIG_CONTENT']).toBe(env['OPENCODE_CONFIG_CONTENT']);
  // The background compaction experiment turns on OpenCode 2's own, beside the gateway; version 1 has none.
  await owner.call('settings.set', { backgroundCompaction: true });
  expect(JSON.parse(harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider)['OPENCODE_CONFIG_CONTENT']!)).toEqual(providerId === 'opencode'
    ? JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)
    : { ...JSON.parse(env['OPENCODE_CONFIG_CONTENT']!), experimental: { background_compaction: true } });
  await owner.call('settings.set', { compactionByType: {
    subagent: { autoCompact: null, backgroundCompaction: false },
    bot: { autoCompact: null, backgroundCompaction: true },
  } });
  const accounts = harness.core.accounts;
  const accountEnv = (thread: { parentThreadId?: string; agentSessionId?: string }) =>
    JSON.parse(accounts.accountEnv(accounts.require(account.id), provider, thread)['OPENCODE_CONFIG_CONTENT']!);
  expect(accountEnv({ parentThreadId: 'parent' })).toEqual(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!));
  expect(accountEnv({ agentSessionId: 'bot' })).toEqual(providerId === 'opencode'
    ? JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)
    : { ...JSON.parse(env['OPENCODE_CONFIG_CONTENT']!), experimental: { background_compaction: true } });
  // A bot's delegated child uses the child policy even if both markers are present.
  expect(accountEnv({ agentSessionId: 'bot', parentThreadId: 'parent' })).toEqual(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!));
  await owner.call('settings.set', { backgroundCompaction: false, compactionByType: {} });

  // Off, the descriptor's configuration is all that is left, and the account answers for itself again.
  await owner.call('settings.set', { subscriptionProxy: { ...config(url), enabled: false } });
  expect(subscriptionProxyEnv(harness.core, provider)).toEqual({});
  expect(harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider)['OPENCODE_CONFIG_CONTENT'])
    .toBe(JSON.stringify(base));
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  // Sharing ACP does not opt other agents into OpenCode's gateway configuration.
  await owner.call('settings.set', { subscriptionProxy: config(url, 'cliproxyapi') });
  const switched = JSON.parse(subscriptionProxyEnv(harness.core, provider)['OPENCODE_CONFIG_CONTENT']!);
  expect(switched[collection].cliproxyapi.models).toEqual(catalog);
  expect(switched[collection].douane).toBeUndefined();
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('antigravity'))).toEqual({});
});

for (const providerId of ['opencode', 'opencode-v2'] as const) test(`${providerId} preserves gateway thinking and token limits without inventing legacy capabilities`, async () => {
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return Response.json({ data: [
      { id: 'antigravity/claude-opus-4-6-thinking', name: 'Opus thinking', supported_endpoint_types: ['openai'],
        context_length: 200_000, max_output_tokens: 64_000,
        thinking: { min: 1024, max: 32_768, zero_allowed: false, dynamic_allowed: true, levels: [] } },
      { id: 'antigravity/gemini-alias', supported_endpoint_types: ['openai'], context_window: 8192, max_output_tokens: 4096, thinking: null },
      { id: 'antigravity/gemini-invalid', context_length: '200000', max_output_tokens: -1, thinking: { min: -1, max: '32000', levels: [] } },
      { id: 'antigravity/gemini-effort-only', supported_endpoint_types: ['openai'],
        supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
      { id: 'antigravity/gemini-context-only', supported_endpoint_types: ['openai'], context_length: 8192 },
      { id: 'antigravity/gemini-output-only', supported_endpoint_types: ['openai'], max_output_tokens: 4096 },
      { id: 'antigravity/gemini-invalid-output', supported_endpoint_types: ['openai'], context_length: 8192, max_output_tokens: -1 },
      { id: 'antigravity/gemini-invalid-context', supported_endpoint_types: ['openai'], context_length: '8192', max_output_tokens: 4096 },
    ] });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}/v1`) } });
  const provider = harness.core.providers.require(providerId);
  const models = await readSubscriptionProxyModels(harness.core, provider);
  expect(models?.[0]?.id).toBe('douane/antigravity/claude-opus-4-6-thinking');
  // The inline config is rebuilt from the persisted catalog, including after later spawns.
  const injected = JSON.parse(subscriptionProxyEnv(harness.core, provider)['OPENCODE_CONFIG_CONTENT']!);
  const catalog = injected[providerId === 'opencode' ? 'provider' : 'providers'].douane.models;
  expect(catalog['antigravity/claude-opus-4-6-thinking']).toEqual({
    name: 'Opus thinking', limit: { context: 200_000, output: 64_000 },
    ...(providerId === 'opencode'
      ? { reasoning: true, interleaved: { field: 'reasoning_content' } }
      : { compatibility: { reasoningField: 'reasoning_content' } }),
  });
  expect(catalog['antigravity/gemini-alias']).toEqual({ name: 'antigravity/gemini-alias', limit: { context: 8192, output: 4096 } });
  expect(catalog['antigravity/gemini-invalid']).toEqual({ name: 'antigravity/gemini-invalid' });
  expect(catalog['antigravity/gemini-effort-only']).toEqual({ name: 'antigravity/gemini-effort-only',
    ...(providerId === 'opencode'
      ? { reasoning: true, interleaved: { field: 'reasoning_content' } }
      : { compatibility: { reasoningField: 'reasoning_content' } }),
  });
  // OpenCode 1 requires both limits when the block is present; OpenCode 2 accepts each independently.
  for (const [id, limit] of [
    ['antigravity/gemini-context-only', { context: 8192 }],
    ['antigravity/gemini-output-only', { output: 4096 }],
    ['antigravity/gemini-invalid-output', { context: 8192 }],
    ['antigravity/gemini-invalid-context', { output: 4096 }],
  ] as const) {
    expect(catalog[id]).toEqual({ name: id, ...(providerId === 'opencode-v2' ? { limit } : {}) });
  }
});

test('Grok runs through Douane by its environment alone, and keeps its own sign-in behind CLIProxyAPI', async () => {
  let listed = 0;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname.endsWith('/models')) listed += 1;
    return Response.json({ data: [{ id: 'xai/grok-5' }] });
  } });
  const url = `http://127.0.0.1:${gateway.port}/v1`;
  harness = await startTestCore({ settings: { subscriptionProxy: config(url) } });
  const owner = await harness.connect();
  await owner.call('subscriptionProxy.key', { key: 'gateway-key' });
  const provider = harness.core.providers.require('grok');
  // The gateway is the login: no sign-in of Grok's own is asked for.
  const account = await owner.call('accounts.add', { providerId: 'grok', label: 'Gateway Grok' });
  expect(account.status).toBe('ok');

  const env = subscriptionProxyEnv(harness.core, provider);
  expect(env).toEqual({
    XAI_API_KEY: 'gateway-key',
    GROK_MODELS_BASE_URL: url,
    // The gateway's Grok models alone, under xAI's ids and in xAI's order.
    GROK_MODELS_LIST_URL: `${url}/models?provider=xai&ids=upstream`,
    // The key check and the chat proxy follow, so the key reaches no other host.
    GROK_XAI_API_BASE_URL: url,
    GROK_CLI_CHAT_PROXY_BASE_URL: url,
    GROK_AUTH_PATH: join(harness.core.dataDir, 'subscription-proxy', 'grok-auth.json'),
    GROK_CONFIG: '{"models":{"extra_headers":{"x-douane-provider":"xai"}}}',
  });
  // A stored sign-in outranks a key: the CLI is pointed at a file that does not exist.
  expect(existsSync(env['GROK_AUTH_PATH']!)).toBe(false);
  // The descriptor unsets what the core inherited under these names; the account's own values come after.
  const spawned = agentEnv(provider, harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider),
    { XAI_API_KEY: 'inherited-key', GROK_MODELS_BASE_URL: 'https://inherited.test/v1' });
  expect(spawned['XAI_API_KEY']).toBe('gateway-key');
  expect(spawned['GROK_MODELS_BASE_URL']).toBe(url);
  // The CLI lists the gateway's models itself: the core reads no catalog to merge into its answer.
  expect(await readSubscriptionProxyModels(harness.core, provider)).toBeNull();
  expect(listed).toBe(0);

  // CLIProxyAPI does not write the list Grok's CLI reads: there the account answers for itself.
  await owner.call('settings.set', { subscriptionProxy: config(url, 'cliproxyapi') });
  expect(subscriptionProxyEnv(harness.core, provider)).toEqual({});
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('claude'))['ANTHROPIC_AUTH_TOKEN']).toBe('gateway-key');

  // A sign-in of Grok's own that xAI refused stays refused whatever a proxy that
  // does not serve Grok is told: its session file must not read as a login again.
  writeFileSync(join(account.isolationDir!, 'auth.json'), '{}');
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('ok');
  harness.core.accounts.authenticationFailed(account.id);
  await owner.call('settings.set', { subscriptionProxy: { ...config(url, 'cliproxyapi'), enabled: false } });
  await owner.call('settings.set', { subscriptionProxy: config(url, 'cliproxyapi') });
  expect(harness.core.accounts.require(account.id).status).toBe('unauthenticated');
  // Douane answers for the account from then on, and leaving it gives the sign-in a fresh reading.
  await owner.call('settings.set', { subscriptionProxy: config(url) });
  expect(harness.core.accounts.require(account.id).status).toBe('ok');
  await owner.call('settings.set', { subscriptionProxy: config(url, 'cliproxyapi') });
  expect(harness.core.accounts.require(account.id).status).toBe('ok');
});

test('legacy CLIProxy catalogs select native families and malformed gateway errors cannot echo the key', async () => {
  let fail = false;
  gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return fail ? new Response('private-token-in-body', { status: 401 }) : Response.json({ data: [
      { id: 'claude/claude-sonnet-4-5' }, { id: 'codex/gpt-5.4', display_name: 'Codex GPT 5.4',
        supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'More reasoning' }, { reasoningEffort: 'xhigh' }, { reasoningEffort: 'xhigh' }] },
      { id: 'gemini-3-pro' }, { id: 'antigravity/gpt-oss-120b-medium' }, { id: 'codex/o5-mini' },
    ] });
  } });
  harness = await startTestCore({ settings: { subscriptionProxy: config(`http://127.0.0.1:${gateway.port}`, 'cliproxyapi') } });
  const owner = await harness.connect();
  const account = await owner.call('accounts.add', { providerId: 'codex', label: 'Gateway' });
  expect((await owner.call('providers.probe', { providerId: 'codex', accountId: account.id })).models).toEqual([{ id: 'codex/gpt-5.4', name: 'Codex GPT 5.4', default: true,
    effort: { levels: [{ id: 'high', label: 'High', description: 'More reasoning' }, { id: 'xhigh', label: 'Extra high' }], default: 'high' } },
    { id: 'antigravity/gpt-oss-120b-medium', name: 'antigravity/gpt-oss-120b-medium', default: false },
    { id: 'codex/o5-mini', name: 'codex/o5-mini', default: false }]);
  fail = true;
  expect(await thrown(owner.call('providers.probe', { providerId: 'codex', accountId: account.id, refresh: true }))).toThrow('HTTP 401');
  expect(JSON.stringify(await owner.call('core.logs', {}))).not.toContain('private-token-in-body');
});

test('native discovery describes the models and the gateway adds only what it routes beyond them', () => {
  const native = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', default: true, speeds: [{ id: 'fast', label: 'Fast' }] }];
  const proxy = [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', default: true }, { id: 'antigravity/claude-sonnet-5', name: 'Sonnet', default: false }];
  expect(mergeProxyModels(native, proxy)).toEqual([native[0]!, proxy[1]!]);
  expect(mergeProxyModels([], proxy)).toBe(proxy);
});

test('a model the gateway names after its subscription is the native one, not a second entry', () => {
  const native = [{ id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', default: true, speeds: [{ id: 'priority', label: 'Fast' }] }];
  const proxy = [{ id: 'codex/gpt-6.1-sol', name: 'GPT 6.1 Sol', default: true }, { id: 'codex/codex-auto-review', name: 'Auto review', default: false },
    { id: 'antigravity/gpt-6.1-sol', name: 'Other pool', default: false }];
  expect(mergeProxyModels(native, proxy)).toEqual([native[0]!, proxy[1]!, proxy[2]!]);
});

test('a Claude child drops the parent session markers and keeps the account variables', () => {
  const saved = process.env.CLAUDE_CODE_ENTRYPOINT;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'parent-session';
  try {
    const env = childEnv({ CLAUDE_CODE_PROMPT_CACHE_TTL: '1h' });
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined();
    expect(env.CLAUDE_CODE_PROMPT_CACHE_TTL).toBe('1h');
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT; else process.env.CLAUDE_CODE_ENTRYPOINT = saved;
  }
});
