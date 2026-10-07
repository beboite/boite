import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SubscriptionProxy } from '@boite/contracts';
import { checkSettingsPatch } from '@boite/contracts';
import { connect } from '../src/client.ts';
import { probedModelsOf } from '../src/drivers/index.ts';
import { childEnv } from '../src/drivers/claude/query.ts';
import { agentEnv } from '../src/providers/resolve.ts';
import { mergeProxyModels, readSubscriptionProxyModels, subscriptionProxyCodexArgs, subscriptionProxyEnv } from '../src/subscription-proxy.ts';
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
    await expect(phone.call('subscriptionProxy.key', { key: null })).rejects.toThrow('owner');
    await expect(phone.call('subscriptionProxy.configure', { subscriptionProxy: proxy, key: null })).rejects.toThrow('owner');
    expect((await phone.call('providers.probe', { providerId: 'codex', accountId: codex.id })).models).toEqual(b.models);
  } finally { phone.close(); }
  await owner.call('settings.set', { subscriptionProxy: { ...proxy, enabled: false } });
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('codex'))).toEqual({});
  expect(probedModelsOf('codex-appserver', 'codex', codex.id)).toBeNull();
  expect(harness.core.accounts.require(claude.id).status).toBe(nativeClaudeStatus);
  expect((await owner.call('quotas.list', {})).some(row => row.accountId === claude.id)).toBe(true);
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

test('OpenCode 2 takes the gateway as one more provider: every model but those with a harness of their own', async () => {
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
      // An id that could not be a key of OpenCode's configuration is left out rather than written into it.
      { id: 'bad id"}', supported_endpoint_types: anyApi },
    ] });
  } });
  const url = `http://127.0.0.1:${gateway.port}/v1`;
  harness = await startTestCore({ settings: { subscriptionProxy: config(url) } });
  const owner = await harness.connect();
  await owner.call('subscriptionProxy.key', { key: 'gateway-key' });
  await owner.call('providers.setEnabled', { providerId: 'opencode-v2', enabled: true });
  // The gateway is the login: no sign-in of OpenCode's own is asked for.
  const account = await owner.call('accounts.add', { providerId: 'opencode-v2', label: 'Gateway OpenCode' });
  expect(account.status).toBe('ok');

  // No OpenCode on a test machine: its own list is missing, the gateway's stands alone.
  const { models } = await owner.call('providers.probe', { providerId: 'opencode-v2', accountId: account.id });
  expect(sent.key).toBe('Bearer gateway-key');
  // Claude, GPT and Grok stay in Claude Code, Codex and Grok, whatever route the gateway gives them.
  expect(models.map(model => model.id)).toEqual(['douane/antigravity/gemini-3-flash', 'douane/antigravity/gpt-oss-120b-medium',
    'douane/muse/muse-code', 'douane/opencode_go/kimi-k3', 'douane/codex/qwen3-coder']);
  expect(models[0]).toEqual({ id: 'douane/antigravity/gemini-3-flash', name: 'Name of antigravity/gemini-3-flash' });

  const provider = harness.core.providers.require('opencode-v2');
  const env = subscriptionProxyEnv(harness.core, provider);
  expect(Object.keys(env).sort()).toEqual(['BOITE_SUBSCRIPTION_PROXY_KEY', 'BOITE_SUBSCRIPTION_PROXY_PREFIX', 'OPENCODE_CONFIG_CONTENT']);
  expect(env['BOITE_SUBSCRIPTION_PROXY_KEY']).toBe('gateway-key');
  expect(env['BOITE_SUBSCRIPTION_PROXY_PREFIX']).toBe('douane/');
  // The key is named, never written: OpenCode reads it from its environment.
  expect(env['OPENCODE_CONFIG_CONTENT']).not.toContain('gateway-key');
  expect(JSON.parse(env['OPENCODE_CONFIG_CONTENT']!)).toEqual({
    // What the descriptor already sends stays: OpenCode's own subagents are denied.
    permissions: [{ action: 'subagent', resource: '*', effect: 'deny' }],
    providers: { douane: {
      package: '@opencode/ai/providers/openai-compatible', name: 'Douane', settings: { baseURL: url }, env: ['BOITE_SUBSCRIPTION_PROXY_KEY'],
      models: {
        'antigravity/gemini-3-flash': { name: 'Name of antigravity/gemini-3-flash' },
        'antigravity/gpt-oss-120b-medium': { name: 'Name of antigravity/gpt-oss-120b-medium' },
        'muse/muse-code': { name: 'Name of muse/muse-code' },
        'opencode_go/kimi-k3': { name: 'Name of opencode_go/kimi-k3' },
        'codex/qwen3-coder': { name: 'Name of codex/qwen3-coder' },
      },
    } },
  });
  // The account's whole environment carries it, over the descriptor's own inline configuration.
  expect(harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider)['OPENCODE_CONFIG_CONTENT']).toBe(env['OPENCODE_CONFIG_CONTENT']);

  // Off, the descriptor's configuration is all that is left, and the account answers for itself again.
  await owner.call('settings.set', { subscriptionProxy: { ...config(url), enabled: false } });
  expect(subscriptionProxyEnv(harness.core, provider)).toEqual({});
  expect(harness.core.accounts.accountEnv(harness.core.accounts.require(account.id), provider)['OPENCODE_CONFIG_CONTENT'])
    .toBe('{"permissions":[{"action":"subagent","resource":"*","effect":"deny"}]}');
  expect((await owner.call('accounts.check', { accountId: account.id })).status).toBe('unauthenticated');
  // OpenCode 1 speaks ACP too and is not served: the proxy is decided per provider.
  await owner.call('settings.set', { subscriptionProxy: config(url) });
  expect(subscriptionProxyEnv(harness.core, harness.core.providers.require('opencode'))).toEqual({});
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
  await expect(owner.call('providers.probe', { providerId: 'codex', accountId: account.id, refresh: true })).rejects.toThrow('HTTP 401');
  expect(JSON.stringify(await owner.call('core.logs', {}))).not.toContain('private-token-in-body');
});

test('native discovery describes the models and the gateway adds only what it routes beyond them', () => {
  const native = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', default: true, speeds: [{ id: 'fast', label: 'Fast' }] }];
  const proxy = [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5', default: true }, { id: 'antigravity/claude-sonnet-5', name: 'Sonnet', default: false }];
  expect(mergeProxyModels(native, proxy)).toEqual([native[0]!, proxy[1]!]);
  expect(mergeProxyModels([], proxy)).toBe(proxy);
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
