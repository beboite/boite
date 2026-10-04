import { subscriptionProxyOf, type ModelInfo, type ProviderDescriptor, type SubscriptionProxy } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, unavailable, RpcFailure } from './errors.ts';

const KEY_SETTING = 'subscription-proxy-key';
export const PROXY_URL_ENV = 'BOITE_SUBSCRIPTION_PROXY_URL';
export const PROXY_KEY_ENV = 'BOITE_SUBSCRIPTION_PROXY_KEY';

export function activeSubscriptionProxy(core: Core, provider: ProviderDescriptor): SubscriptionProxy | null {
  return subscriptionProxyOf(core.settings.get(), provider.protocol);
}

export function proxyApiUrl(proxy: SubscriptionProxy): string {
  return `${proxy.baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '')}/v1`;
}

/** The gateway key stays out of settings snapshots, journal events and process arguments. */
export function proxyKey(core: Core): string {
  const key = core.journal.getSetting(KEY_SETTING);
  return typeof key === 'string' && key ? key : 'boite-subscription-proxy';
}

export function subscriptionProxyEnv(core: Core, provider: ProviderDescriptor): Record<string, string> {
  const proxy = activeSubscriptionProxy(core, provider);
  if (!proxy) return {};
  const key = proxyKey(core);
  if (provider.protocol === 'claude-sdk') return {
    ANTHROPIC_BASE_URL: proxyApiUrl(proxy).replace(/\/v1$/, ''),
    ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '',
    // The gateway relays Messages verbatim to Anthropic on a subscription. A
    // custom base URL would otherwise switch Claude Code to its third-party
    // behavior: no tool search, no first-party model aliases, and a 5-minute
    // prompt cache where a subscription gets one hour. Fast mode's organization
    // check needs a native login the gateway holds instead, so it is skipped.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: '1',
    CLAUDE_CODE_PROMPT_CACHE_TTL: '1h',
    CLAUDE_CODE_SKIP_FAST_MODE_ORG_CHECK: '1',
  };
  return { [PROXY_URL_ENV]: proxyApiUrl(proxy), [PROXY_KEY_ENV]: key };
}

/** Only the address is an argument; Codex reads the key from its child's environment. */
export function subscriptionProxyCodexArgs(args: string[], env: Record<string, string>): string[] {
  const baseUrl = env[PROXY_URL_ENV];
  if (!baseUrl) return args;
  const provider = 'boite_subscription_proxy';
  const config = [
    `model_provider=${JSON.stringify(provider)}`,
    `model_providers.${provider}.name="Subscription proxy"`,
    `model_providers.${provider}.base_url=${JSON.stringify(baseUrl)}`,
    `model_providers.${provider}.wire_api="responses"`,
    `model_providers.${provider}.supports_websockets=true`,
    `model_providers.${provider}.requires_openai_auth=false`,
    `model_providers.${provider}.env_key="${PROXY_KEY_ENV}"`,
  ];
  return [...args, ...config.flatMap(value => ['--config', value])];
}

/**
 * The agent's native list first, as a subscription shows it, then the models
 * only the gateway routes. Without a native list the gateway's stands alone.
 */
export function mergeProxyModels(native: ModelInfo[], proxy: ModelInfo[]): ModelInfo[] {
  if (!native.length) return proxy;
  const ids = new Set(native.map(model => model.id));
  return [...native, ...proxy.filter(model => !ids.has(model.id)).map(model => ({ ...model, default: false }))];
}

/** Effort controls come from explicit gateway capabilities, including Codex's native metadata. */
function proxyEffort(row: Record<string, unknown>): ModelInfo['effort'] | undefined {
  const thinking = row.thinking as { levels?: unknown } | null;
  const native = Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : [];
  const options = native.length ? native : Array.isArray(thinking?.levels) ? thinking.levels.map(reasoningEffort => ({ reasoningEffort })) : [];
  const levels: NonNullable<ModelInfo['effort']>['levels'] = [];
  for (const option of options.slice(0, 20)) {
    if (!option || typeof option !== 'object') continue;
    const { reasoningEffort: id, description } = option as { reasoningEffort?: unknown; description?: unknown };
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(id) || levels.some(level => level.id === id)) continue;
    levels.push({ id, label: id === 'xhigh' ? 'Extra high' : `${id[0]!.toUpperCase()}${id.slice(1)}`,
      ...(typeof description === 'string' && description ? { description: description.slice(0, 2000) } : {}) });
  }
  if (!levels.length) return undefined;
  const wanted = row.defaultReasoningEffort;
  return { levels, default: typeof wanted === 'string' && levels.some(level => level.id === wanted) ? wanted : levels[0]!.id };
}

type ModelFamily = 'anthropic' | 'openai' | 'google' | 'xai' | 'meta';

const ROUTE_FAMILIES: Record<string, ModelFamily> = {
  claude: 'anthropic', anthropic: 'anthropic', codex: 'openai', openai: 'openai', chatgpt: 'openai',
  gemini: 'google', google: 'google', xai: 'xai', grok: 'xai', muse: 'meta',
};

/** Open-weight families: offered to every harness, whatever routing prefix the gateway gives them. */
const OPEN_MODEL = /gpt-oss|kimi|qwen|llama|deepseek|mistral|mixtral|glm/i;

/**
 * The vendor whose harness a proprietary model belongs to, or null for an open
 * or unknown model. The name is read after the gateway's routing prefix, so
 * `antigravity/claude-opus-5-5` is a Claude model; an unknown name falls back
 * to a vendor prefix, so `codex/computer-use-preview` is an OpenAI model.
 */
export function proprietaryFamily(id: string): ModelFamily | null {
  const slash = id.lastIndexOf('/');
  const name = id.slice(slash + 1);
  if (OPEN_MODEL.test(name)) return null;
  if (/claude|opus|sonnet|haiku|fable/i.test(name)) return 'anthropic';
  if (/^(?:chatgpt|gpt|codex)(?:[-_.\d]|$)|^openai(?:[-_]|$)|^o\d+(?:-|$)/i.test(name)) return 'openai';
  if (/gemini/i.test(name)) return 'google';
  if (/grok/i.test(name)) return 'xai';
  if (/muse/i.test(name)) return 'meta';
  return slash > 0 ? ROUTE_FAMILIES[id.slice(0, slash).split('/').pop()!.toLowerCase()] ?? null : null;
}

/** Discovery is a bounded HTTP read on the core, so a phone uses its host's gateway. */
export async function readSubscriptionProxyModels(core: Core, provider: ProviderDescriptor): Promise<ModelInfo[] | null> {
  const proxy = activeSubscriptionProxy(core, provider);
  if (!proxy) return null;
  let response: Response;
  try {
    response = await fetch(`${proxyApiUrl(proxy)}/models`, {
      headers: { Authorization: `Bearer ${proxyKey(core)}` },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
  } catch { throw unavailable('Subscription proxy model discovery could not reach the configured API URL'); }
  if (!response.ok) throw unavailable(`Subscription proxy model discovery returned HTTP ${response.status}`);
  // Do not propagate a gateway's raw body: it can echo a credential.
  let body: { data?: unknown };
  try { body = await response.json() as { data?: unknown }; }
  catch { throw unavailable('Subscription proxy model discovery expected an OpenAI models response'); }
  if (!body || typeof body !== 'object' || !Array.isArray(body.data) || body.data.length > 10_000) throw unavailable('Subscription proxy model discovery expected a bounded data array');
  const seen = new Set<string>();
  const models: ModelInfo[] = [];
  for (const row of body.data as Record<string, unknown>[]) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id || row.id.length > 200 || seen.has(row.id)) continue;
    const endpoints = row.supported_endpoint_types;
    const own = provider.protocol === 'claude-sdk' ? 'anthropic' : 'openai';
    const family = proprietaryFamily(row.id);
    // A gateway can translate any model to any API; a proprietary model still stays in its own harness.
    // Gemini's harness, Antigravity, cannot go through a gateway, so its models stay usable in both.
    if (family !== null && family !== 'google' && family !== own) continue;
    if (Array.isArray(endpoints) && !endpoints.includes(provider.protocol === 'claude-sdk' ? 'anthropic' : 'openai-response')) continue;
    // Older gateways omit endpoint metadata; their known native model families remain selectable.
    if (!Array.isArray(endpoints) && (provider.protocol === 'claude-sdk' ? !/claude|opus|sonnet|haiku|fable/i.test(row.id) : !/gpt|codex|\bo[134](?:-|$)/i.test(row.id))) continue;
    seen.add(row.id);
    const name = row.name ?? row.display_name;
    const effort = proxyEffort(row);
    models.push({ id: row.id, name: typeof name === 'string' && name ? name.slice(0, 200) : row.id, default: models.length === 0,
      ...(effort ? { effort } : {}) });
  }
  if (!models.length) throw unavailable(`Subscription proxy listed no compatible models for ${provider.name}`);
  return models;
}

function validateKey(key: unknown): asserts key is string | null {
  if (key !== null && (typeof key !== 'string' || key.length > 4096 || !key.trim() || /[\u0000-\u0020\u007f]/.test(key))) {
    throw invalidParams('subscriptionProxy.key must be null or a non-empty token without whitespace');
  }
}

function writeKey(core: Core, key: string | null): void {
  if (key === null) core.journal.deleteSetting(KEY_SETTING);
  else core.journal.setSetting(KEY_SETTING, key);
}

export function registerSubscriptionProxy(core: Core): void {
  core.router.register('subscriptionProxy.key', ({ key }) => {
    validateKey(key);
    try { writeKey(core, key); }
    catch { throw unavailable('Subscription proxy key could not be saved'); }
    // The last answer was read with the previous key.
    core.quotas.gateway.reset();
    return { configured: key !== null };
  });
  core.router.register('subscriptionProxy.quotas', ({ refresh }) => {
    if (refresh !== undefined && typeof refresh !== 'boolean') throw invalidParams('subscriptionProxy.quotas refresh must be a boolean');
    return core.quotas.gateway.read(refresh === true);
  });
  core.router.register('subscriptionProxy.configure', ({ subscriptionProxy, key }) => {
    if (!subscriptionProxy || typeof subscriptionProxy !== 'object') throw invalidParams('subscriptionProxy configuration is required');
    if (key !== undefined) validateKey(key);
    let settings;
    try {
      settings = core.settings.set({ subscriptionProxy }, key === undefined ? undefined : () => writeKey(core, key));
    } catch (error) {
      if (error instanceof RpcFailure) throw error;
      // A storage error must not expose a bound private value to the caller or logs.
      throw unavailable('Subscription proxy configuration could not be saved');
    }
    // A new key can change the answer even when the settings did not.
    if (key !== undefined) core.quotas.gateway.reset();
    return settings;
  });
}
