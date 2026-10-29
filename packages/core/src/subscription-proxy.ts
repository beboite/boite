import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MODEL_ROUTE_FAMILIES, nativeModelId, subscriptionProxyName, subscriptionProxyOf, type ModelFamily, type ModelInfo, type ProviderDescriptor, type ProviderId, type SubscriptionProxy } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused, unavailable, RpcFailure } from './errors.ts';
import { isOpenCode, OPENCODE_V2 } from './providers/opencode.ts';
import { profileFor } from './providers/resolve.ts';

const KEY_SETTING = 'subscription-proxy-key';
/** The gateway models both OpenCode versions were last offered, kept so a restart can start a turn on one. */
const OPENCODE_MODELS_SETTING = 'subscription-proxy-opencode-models';
export const PROXY_URL_ENV = 'BOITE_SUBSCRIPTION_PROXY_URL';
export const PROXY_KEY_ENV = 'BOITE_SUBSCRIPTION_PROXY_KEY';
/**
 * The start of every model id the core injected into an agent as a provider of
 * its own, `douane/`. An agent may take such a model without listing it among
 * its own, which is what the ACP driver reads this for.
 */
export const PROXY_PREFIX_ENV = 'BOITE_SUBSCRIPTION_PROXY_PREFIX';
const GROK: ProviderId = 'grok';

export function activeSubscriptionProxy(core: Core, provider: ProviderDescriptor): SubscriptionProxy | null {
  return subscriptionProxyOf(core.settings.get(), provider, core.quotas?.gateway.state());
}

interface GatewayModel {
  id: string;
  name: string;
  reasoning?: true;
  limit?: { context?: number; output?: number };
}

function positiveTokenLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function gatewayModelLimits(context: unknown, output: unknown): GatewayModel['limit'] {
  const contextLimit = positiveTokenLimit(context), outputLimit = positiveTokenLimit(output);
  if (contextLimit === undefined && outputLimit === undefined) return undefined;
  return { ...(contextLimit === undefined ? {} : { context: contextLimit }), ...(outputLimit === undefined ? {} : { output: outputLimit }) };
}

/** The gateway models last offered to OpenCode, read back from the journal: a bad row is dropped, not trusted. */
function openCodeGatewayModels(core: Core): GatewayModel[] {
  const stored = core.journal.getSetting(OPENCODE_MODELS_SETTING);
  if (!Array.isArray(stored)) return [];
  return stored.filter((row): row is GatewayModel =>
    row !== null && typeof row === 'object' && typeof (row as GatewayModel).id === 'string' && typeof (row as GatewayModel).name === 'string')
    .map(row => {
      const limit = gatewayModelLimits(row.limit?.context, row.limit?.output);
      return { id: row.id, name: row.name, ...(row.reasoning === true ? { reasoning: true as const } : {}), ...(limit ? { limit } : {}) };
    });
}

/**
 * Both OpenCode versions take the gateway as one more model provider, named after the
 * gateway's kind, beside the ones it already has. The provider is written into
 * the inline configuration the descriptor already sends, so what that carries
 * (the denial of OpenCode's own subagents) is kept. A custom provider lists
 * only the models its configuration names, hence the stored catalog. The key
 * goes by environment, where the provider block tells OpenCode to look.
 */
function openCodeGatewayEnv(core: Core, provider: ProviderDescriptor, proxy: SubscriptionProxy, key: string): Record<string, string> {
  let base: Record<string, unknown> = {};
  try {
    const declared: unknown = JSON.parse(profileFor(provider)?.env?.['OPENCODE_CONFIG_CONTENT'] ?? '{}');
    if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) base = declared as Record<string, unknown>;
  } catch {
    // A descriptor whose inline configuration is not JSON keeps the gateway and loses nothing it could have applied.
  }
  const collection = provider.id === OPENCODE_V2 ? 'providers' : 'provider';
  const declaredProviders = base[collection];
  const others = declaredProviders !== null && typeof declaredProviders === 'object' && !Array.isArray(declaredProviders) ? declaredProviders as Record<string, unknown> : {};
  const models = Object.fromEntries(openCodeGatewayModels(core).map((model) => [model.id, {
    name: model.name,
    ...(model.limit && (provider.id === OPENCODE_V2 || (model.limit.context !== undefined && model.limit.output !== undefined))
      ? { limit: model.limit } : {}),
    ...(model.reasoning ? provider.id === OPENCODE_V2
      ? { compatibility: { reasoningField: 'reasoning_content' } }
      : { reasoning: true, interleaved: { field: 'reasoning_content' } } : {}),
  }]));
  const integration = provider.id === OPENCODE_V2 ? {
    package: '@opencode/ai/providers/openai-compatible', name: subscriptionProxyName(proxy.kind),
    settings: { baseURL: proxyApiUrl(proxy) }, env: [PROXY_KEY_ENV], models,
  } : {
    npm: '@ai-sdk/openai-compatible', name: subscriptionProxyName(proxy.kind),
    options: { baseURL: proxyApiUrl(proxy), apiKey: `{env:${PROXY_KEY_ENV}}` }, models,
  };
  const content = {
    ...base,
    [collection]: {
      ...others,
      [proxy.kind]: integration,
    },
  };
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify(content), [PROXY_KEY_ENV]: key, [PROXY_PREFIX_ENV]: `${proxy.kind}/` };
}

/**
 * Grok's CLI is sent to the gateway by its environment alone, and stays the
 * same agent. It lists the gateway's Grok models itself (`provider=xai`) under
 * xAI's ids and in xAI's order (`ids=upstream`): a thread keeps its model
 * whether the proxy is on or off, and a session opens on xAI's default, the
 * first of a list. Each row carries the window and the efforts the CLI reads.
 * Turns name the pool they spend, since another subscription of the gateway
 * can route a model of the same name.
 *
 * The CLI prefers a stored sign-in to a key and would send that token to the
 * gateway. `GROK_AUTH_PATH` points it at a file nothing writes, so it finds no
 * sign-in and the account's own stays as it was for when the proxy is off. Its
 * key check and its chat proxy move to the gateway with the rest: the key
 * never reaches xAI.
 */
function grokGatewayEnv(core: Core, proxy: SubscriptionProxy, key: string): Record<string, string> {
  const api = proxyApiUrl(proxy);
  return {
    XAI_API_KEY: key,
    GROK_MODELS_BASE_URL: api,
    GROK_MODELS_LIST_URL: `${api}/models?provider=xai&ids=upstream`,
    GROK_XAI_API_BASE_URL: api,
    GROK_CLI_CHAT_PROXY_BASE_URL: api,
    GROK_AUTH_PATH: join(core.dataDir, 'subscription-proxy', 'grok-auth.json'),
    GROK_CONFIG: JSON.stringify({ models: { extra_headers: { 'x-douane-provider': 'xai' } } }),
  };
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
  if (provider.id === 'muse') return museGatewayEnv(core, proxy, key);
  if (isOpenCode(provider.id)) return openCodeGatewayEnv(core, provider, proxy, key);
  if (provider.id === GROK) return grokGatewayEnv(core, proxy, key);
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

/** Muse serve takes its endpoint from settings, never the TUI's --base-url flag. Keep native settings and logins intact. */
function museGatewayEnv(core: Core, proxy: SubscriptionProxy, key: string): Record<string, string> {
  const api = proxyApiUrl(proxy).replace(/\/v1$/, '/muse-code');
  const identity = createHash('sha256').update(api).digest('hex').slice(0, 24);
  const directory = join(core.dataDir, 'subscription-proxy', 'muse', identity);
  mkdirSync(join(directory, 'muse'), { recursive: true });
  const settings = join(directory, 'muse', 'settings.json');
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: api, auth: 'bearer' } }));
  // META_API_KEY overrides a saved login and is deliberately supplied after the profile's unsetEnv.
  return { XDG_CONFIG_HOME: directory, META_API_KEY: key };
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
 * A gateway can name a model after the subscription that serves it
 * (`codex/gpt-5.4`): behind a vendor's route that is the agent's own model
 * again, already listed with its speeds, so it is not offered twice. Another
 * route to the same name (`antigravity/claude-sonnet-5`) is another pool and
 * stays.
 */
export function mergeProxyModels(native: ModelInfo[], proxy: ModelInfo[]): ModelInfo[] {
  if (!native.length) return proxy;
  const ids = new Set(native.map(model => model.id));
  const listed = (id: string): boolean => ids.has(id) || ids.has(nativeModelId(id));
  return [...native, ...proxy.filter(model => !listed(model.id)).map(model => ({ ...model, default: false }))];
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
  const route = slash > 0 ? id.slice(0, slash).split('/').pop()!.toLowerCase() : '';
  return Object.hasOwn(MODEL_ROUTE_FAMILIES, route) ? MODEL_ROUTE_FAMILIES[route]! : null;
}

/** Discovery is a bounded HTTP read on the core, so a phone uses its host's gateway. */
export async function readSubscriptionProxyModels(core: Core, provider: ProviderDescriptor): Promise<ModelInfo[] | null> {
  if (provider.id === 'muse') {
    // Its own MSP catalog carries native model ids and efforts, through Douane's Muse endpoint.
    return null;
  }
  const proxy = activeSubscriptionProxy(core, provider);
  if (!proxy) return null;
  // Grok's CLI reads the gateway's list itself and takes no model outside it: its discovery is the whole catalog.
  if (provider.id === GROK) return null;
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
  if (isOpenCode(provider.id)) return openCodeModels(core, proxy, body.data as Record<string, unknown>[]);
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

/** The families whose models stay in the harness their vendor ships: Claude Code, Codex and Grok. */
const OWN_HARNESS: ReadonlySet<ModelFamily> = new Set(['anthropic', 'openai', 'xai']);
/** A model id becomes a key of OpenCode's configuration and part of a `provider/model` name. */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

/**
 * What OpenCode is offered from the gateway: Gemini, Muse and open-weight
 * families, plus Antigravity Claude routes with explicit Chat Completions support. Each is
 * named `<kind>/<gateway id>`, the way OpenCode names a model of a provider.
 * The catalog is stored for the next spawn, and an empty one is an answer: the
 * agent's own models stand, where the other harnesses would have nothing left.
 */
function openCodeModels(core: Core, proxy: SubscriptionProxy, rows: Record<string, unknown>[]): ModelInfo[] {
  const catalog: GatewayModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !OPENCODE_MODEL_ID.test(row.id) || seen.has(row.id)) continue;
    const family = proprietaryFamily(row.id);
    const endpoints = row.supported_endpoint_types;
    const antigravityClaude = family === 'anthropic' && /^antigravity\//i.test(row.id)
      && Array.isArray(endpoints) && endpoints.includes('openai');
    if (family !== null && OWN_HARNESS.has(family) && !antigravityClaude) continue;
    // A gateway that says which APIs a model answers must name Chat Completions; one that says nothing is taken at its word.
    if (Array.isArray(endpoints) && !endpoints.includes('openai')) continue;
    seen.add(row.id);
    const name = row.name ?? row.display_name;
    const thinking = row.thinking !== null && typeof row.thinking === 'object' && !Array.isArray(row.thinking)
      ? row.thinking as Record<string, unknown> : null;
    const reasoning = proxyEffort(row) !== undefined || (thinking !== null && (positiveTokenLimit(thinking.min) !== undefined
      || positiveTokenLimit(thinking.max) !== undefined || thinking.dynamic_allowed === true));
    const limit = gatewayModelLimits(positiveTokenLimit(row.context_length) ?? row.context_window, row.max_output_tokens);
    catalog.push({ id: row.id, name: typeof name === 'string' && name ? name.slice(0, 200) : row.id,
      ...(reasoning ? { reasoning: true } : {}), ...(limit ? { limit } : {}) });
  }
  if (JSON.stringify(catalog) !== JSON.stringify(openCodeGatewayModels(core))) core.journal.setSetting(OPENCODE_MODELS_SETTING, catalog);
  return catalog.map((model) => ({ id: `${proxy.kind}/${model.id}`, name: model.name }));
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
  core.router.register('subscriptionProxy.setEnabled', ({ enabled }) => {
    if (typeof enabled !== 'boolean') throw invalidParams('subscriptionProxy.setEnabled enabled must be a boolean', { field: 'enabled' });
    const proxy = core.settings.get().subscriptionProxy;
    if (!proxy?.baseUrl) throw refused('no subscription proxy is configured: the owner sets one up in Settings > Accounts', { field: 'subscriptionProxy' });
    if (proxy.enabled === enabled) return core.settings.get();
    return core.settings.set({ subscriptionProxy: { ...proxy, enabled } });
  });
}
