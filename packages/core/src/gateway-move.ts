import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { subscriptionProxyOrigin, type Account, type GatewayMoveItem, type GatewayMoveOutcome, type GatewayMovePlan, type GatewayMoveReason, type ProviderDescriptor, type SubscriptionProxy } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused, unavailable, RpcFailure } from './errors.ts';
import { homePath } from './paths.ts';
import { hostAgentsEnabled, profileFor } from './providers/resolve.ts';
import { DOUANE_PLUGIN } from './plugins/gateway.ts';
import { localProxy } from './settings.ts';
import { proxyApiUrl } from './subscription-proxy.ts';

/**
 * Moving this machine's logins into Douane. The core reads each login file
 * itself and posts it to the gateway's `/admin/api/accounts/import`; a client
 * only ever sees what could move and what happened, never a value. Claude,
 * Codex and Grok refresh tokens rotate, so once Douane holds a login and
 * refreshes it, Boite's own copy stops working: this is a move, not a copy.
 */

const TOKEN_SETTING = 'subscription-proxy-management-token';
/** The agents whose own sign-in file Douane imports as it is. */
const LOGIN_FILES: Readonly<Record<string, string>> = { claude: 'claude', codex: 'codex', grok: 'xai' };
const OPENCODE = 'opencode';
const OPENCODE_AUTH = join('opencode', 'auth.json');
const COPILOT = 'github-copilot';
const OPENCODE_GO = 'opencode-go';
/** OpenCode's packages that speak OpenAI's Chat Completions at the catalog's `api` address. */
const CHAT_PACKAGES = new Set(['@ai-sdk/openai-compatible', '@openrouter/ai-sdk-provider', '@ai-sdk/openai']);
/** Names Douane keeps for its own providers: a custom endpoint's route cannot be one. */
const DOUANE_PROVIDERS = new Set(['codex', 'chatgpt', 'claude', 'anthropic', 'gemini', 'gemini-cli', 'antigravity', 'qwen', 'kimi', 'kimi-ai',
  'xai', 'grok', 'opencode_go', 'opencode-go', 'opencode', 'copilot', 'github-copilot', 'github_copilot', 'openai', 'openai_compatible', 'openai-compatible']);
const REQUEST_TIMEOUT_MS = 15_000;

interface CatalogEntry { name?: unknown; api?: unknown; npm?: unknown }

/** An item and, when it can move, how to build what the gateway receives. Values stay on the core. */
interface Prepared {
  item: GatewayMoveItem;
  identity: string | null;
  payload?: () => Record<string, unknown>;
}

interface GatewayAccount { id?: unknown; provider?: unknown; email?: unknown; route?: unknown; base_url?: unknown }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readJson(path: string): Record<string, unknown> | 'missing' | 'unreadable' {
  if (!existsSync(path)) return 'missing';
  try { return record(JSON.parse(readFileSync(path, 'utf8'))) ?? 'unreadable'; }
  catch { return 'unreadable'; }
}

/**
 * OpenCode's copy of the models.dev catalog: where it learnt each provider's
 * API address. OpenCode keeps it under the XDG cache home, which an isolated
 * account does not move, so every account reads the same one.
 */
function openCodeCatalog(): Record<string, CatalogEntry> {
  const cache = process.env.XDG_CACHE_HOME || join(homePath(), '.cache');
  const read = readJson(join(cache, 'opencode', 'models.json'));
  return typeof read === 'string' ? {} : read as Record<string, CatalogEntry>;
}

/** The route a key is served under: OpenCode's provider id, renamed when Douane keeps that name. */
export function endpointRoute(providerId: string): string | null {
  if (providerId === OPENCODE) return 'zen';
  let route = providerId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32).replace(/[-_]+$/, '');
  if (!route) return null;
  if (DOUANE_PROVIDERS.has(route)) route = `${route.slice(0, 28)}-api`;
  return route;
}

function baseOf(core: Core, account: Account, provider: ProviderDescriptor): string | null {
  if (account.isolationDir !== null) return account.isolationDir;
  // A test core stays away from the developer's own logins.
  return hostAgentsEnabled() ? core.accounts.defaultLocation(provider) : null;
}

function loginItem(account: Account, provider: ProviderDescriptor, base: string): Prepared {
  const own = profileFor(provider)?.session;
  const file = (own !== undefined && own.length > 0 ? own : provider.auth.session ?? [])[0];
  const item: GatewayMoveItem = { id: `${account.id}:login`, accountId: account.id, providerId: provider.id, kind: 'login', movable: false, reason: null };
  const content = file === undefined ? 'missing' : readJson(join(base, file));
  if (typeof content === 'string') return { item: { ...item, reason: content === 'missing' ? 'signedOut' : 'unreadable' }, identity: account.identity };
  return { item: { ...item, movable: true }, identity: account.identity, payload: () => content };
}

function openCodeItems(account: Account, base: string, catalog: () => Record<string, CatalogEntry>): Prepared[] {
  const auth = readJson(join(base, OPENCODE_AUTH));
  if (auth === 'missing') return [];
  const common = { accountId: account.id, providerId: account.providerId };
  if (auth === 'unreadable') return [{ item: { ...common, id: `${account.id}:login`, kind: 'login', movable: false, reason: 'unreadable' }, identity: null }];
  const items: Prepared[] = [];
  for (const [id, raw] of Object.entries(auth)) {
    const entry = record(raw);
    if (entry === null) continue;
    const listed = record(catalog()[id]);
    const source = { id, name: typeof listed?.name === 'string' && listed.name ? listed.name.slice(0, 120) : id };
    if (id === COPILOT && entry.type === 'oauth') {
      items.push({ item: { ...common, id: `${account.id}:copilot`, kind: 'copilot', source, movable: true, reason: null }, identity: null,
        // Only the Copilot entry leaves, in the shape of OpenCode's file.
        payload: () => ({ [COPILOT]: entry }) });
      continue;
    }
    const key = entry.type === 'api' && typeof entry.key === 'string' && entry.key ? entry.key : null;
    if (key === null) {
      items.push({ item: { ...common, id: `${account.id}:key:${id}`, kind: 'endpoint', source, movable: false, reason: 'otherSignIn' }, identity: null });
      continue;
    }
    if (id === OPENCODE_GO) {
      items.push({ item: { ...common, id: `${account.id}:key:${id}`, kind: 'opencodeGo', source, movable: true, reason: null }, identity: null,
        payload: () => ({ type: 'opencode_go', api_key: key }) });
      continue;
    }
    const api = typeof listed?.api === 'string' && /^https?:\/\/[^\s?#]+$/i.test(listed.api) ? listed.api.replace(/\/+$/, '') : null;
    const route = endpointRoute(id);
    let reason: GatewayMoveReason | null = null;
    if (api === null || route === null) reason = 'noAddress';
    else if (typeof listed?.npm === 'string' && !CHAT_PACKAGES.has(listed.npm)) reason = 'otherApi';
    const item: GatewayMoveItem = { ...common, id: `${account.id}:key:${id}`, kind: 'endpoint', source,
      ...(route !== null ? { route } : {}), ...(api !== null ? { baseUrl: api } : {}), movable: reason === null, reason };
    items.push(reason !== null ? { item, identity: null } : { item, identity: null,
      payload: () => ({ type: 'openai_compatible', name: source.name, route, base_url: api, api_key: key, dialect: 'chat' }) });
  }
  return items;
}

function prepare(core: Core): Prepared[] {
  let catalog: Record<string, CatalogEntry> | null = null;
  const lazyCatalog = () => catalog ??= openCodeCatalog();
  const prepared: Prepared[] = [];
  for (const account of core.accounts.list()) {
    const provider = core.providers.get(account.providerId);
    if (provider === undefined) continue;
    const login = Object.hasOwn(LOGIN_FILES, provider.id);
    if (!login && provider.id !== OPENCODE) continue;
    const base = baseOf(core, account, provider);
    if (base === null) continue;
    if (login) prepared.push(loginItem(account, provider, base));
    else prepared.push(...openCodeItems(account, base, lazyCatalog));
  }
  return prepared;
}

/** The Douane a move talks to: the proxy's, or with `plugin` the Douane plugin running on this core. */
function douaneOf(core: Core, target: unknown = 'proxy'): SubscriptionProxy | null {
  if (target !== 'proxy' && target !== 'plugin') throw invalidParams('target must be proxy, plugin or absent', { field: 'target', expected: 'proxy or plugin' });
  let proxy: SubscriptionProxy | null;
  if (target === 'plugin') {
    proxy = core.plugins.gateways.running(DOUANE_PLUGIN) ? localProxy({ enabled: false, kind: 'douane', baseUrl: '', dashboardUrl: '' }, core.plugins.gateways.port(DOUANE_PLUGIN)) : null;
  } else {
    const saved = core.settings.get().subscriptionProxy;
    proxy = saved && saved.kind === 'douane' && saved.baseUrl ? saved : null;
  }
  assertGateway(core, proxy);
  return proxy;
}

/** Check the resolved address, including disabled saved proxies and the plugin's local port. */
function assertGateway(core: Core, proxy: SubscriptionProxy | null): void {
  const key = core.policy.gatewayBlock(proxy?.baseUrl);
  if (key !== null) throw core.policy.refusal(key, proxy?.baseUrl);
}

function managementToken(core: Core): string | null {
  const token = core.journal.getSetting(TOKEN_SETTING);
  return typeof token === 'string' && token ? token : null;
}

export function movePlan(core: Core, target?: unknown): GatewayMovePlan {
  const proxy = douaneOf(core, target);
  return { origin: proxy ? subscriptionProxyOrigin(proxy) : null, managementToken: managementToken(core) !== null, items: prepare(core).map(entry => entry.item) };
}

/** Every string of a payload long enough to be a credential, so a gateway's answer cannot echo one back. */
function secretsOf(value: unknown, into: string[] = []): string[] {
  if (typeof value === 'string') { if (value.length >= 8) into.push(value); }
  else if (Array.isArray(value)) for (const entry of value) secretsOf(entry, into);
  else if (value !== null && typeof value === 'object') for (const entry of Object.values(value)) secretsOf(entry, into);
  return into;
}

function scrub(message: string, secrets: readonly string[]): string {
  let text = message.slice(0, 300);
  for (const secret of secrets) text = text.split(secret).join('[hidden]');
  return text;
}

/** One management call. A login page, a refusal or a silence becomes a sentence naming what to do. */
async function gatewayCall(core: Core, proxy: SubscriptionProxy, token: string | null, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  assertGateway(core, proxy);
  const origin = subscriptionProxyOrigin(proxy);
  const url = `${proxyApiUrl(proxy).replace(/\/v1$/, '')}/admin/api${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-management-key': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw unavailable(`Douane at ${origin} could not be reached`);
  }
  try { assertGateway(core, proxy); }
  catch (error) { await response.body?.cancel().catch(() => {}); throw error; }
  const type = response.headers.get('content-type') ?? '';
  if ((response.status >= 300 && response.status < 400) || /text\/html/i.test(type)) {
    await response.body?.cancel().catch(() => {});
    throw refused(`Douane at ${origin} answered with a sign-in page: its management API is behind a login. Enter its management token, or reach it at an address without that login`, { field: 'managementToken' });
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => {});
    throw refused(`Douane at ${origin} refused the management request (HTTP ${response.status}): ${token ? 'the management token is not the one it expects' : 'enter its management token'}`, { field: 'managementToken' });
  }
  if (response.status === 404 || response.status === 405) {
    await response.body?.cancel().catch(() => {});
    throw refused(`${origin} has no Douane account import at /admin/api: check the API URL, or update Douane`, { field: 'subscriptionProxy.baseUrl' });
  }
  let json: Record<string, unknown> | null = null;
  try { json = record(await response.json()); } catch { /* answered below */ }
  assertGateway(core, proxy);
  if (json === null) throw unavailable(`Douane at ${origin} answered HTTP ${response.status} without JSON`);
  return { status: response.status, json };
}

function validateToken(token: unknown): asserts token is string | null {
  if (token !== null && (typeof token !== 'string' || token.length > 4096 || !token.trim() || /[\u0000- \u007f]/.test(token))) {
    throw invalidParams('managementToken must be null or a non-empty token without whitespace', { field: 'managementToken' });
  }
}

const SUBSCRIPTION_OF: Readonly<Record<string, string>> = { copilot: 'copilot', opencodeGo: 'opencode_go' };

/** The cores with a move running: one at a time, or two would race on the gateway's list. */
const moving = new WeakSet<Core>();

export async function moveToGateway(core: Core, ids: unknown, token: unknown, target?: unknown): Promise<{ outcomes: GatewayMoveOutcome[] }> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || ids.some(id => typeof id !== 'string' || id.length > 300)) {
    throw invalidParams('ids must be 1 to 200 item ids from subscriptionProxy.movePlan', { field: 'ids' });
  }
  if (token !== undefined) validateToken(token);
  const proxy = douaneOf(core, target);
  if (proxy === null) {
    if (target === 'plugin') throw refused('start the Douane plugin first: moving logins needs it running', { field: 'target', expected: 'a running Douane plugin' });
    throw refused('configure a Douane gateway first: moving logins needs Douane', { field: 'subscriptionProxy.kind', expected: 'douane' });
  }
  if (moving.has(core)) throw refused('a move to Douane is already running');
  moving.add(core);
  try {
    if (token !== undefined) {
      try { if (token === null) core.journal.deleteSetting(TOKEN_SETTING); else core.journal.setSetting(TOKEN_SETTING, token); }
      catch { throw unavailable('The management token could not be saved'); }
    }
    const secret = managementToken(core);
    const known = new Map(prepare(core).map(entry => [entry.item.id, entry]));
    const listed = await gatewayCall(core, proxy, secret, '/accounts');
    const before: GatewayAccount[] = Array.isArray(listed.json.accounts) ? listed.json.accounts.filter(record) as GatewayAccount[] : [];
    const before_ids = new Set(before.map(account => account.id).filter((id): id is string => typeof id === 'string'));
    const outcomes: GatewayMoveOutcome[] = [];
    for (const id of new Set(ids as string[])) {
      const entry = known.get(id);
      if (entry === undefined) { outcomes.push({ id, outcome: 'missing', reason: null, message: null }); continue; }
      const { item } = entry;
      if (!item.movable || entry.payload === undefined) { outcomes.push({ id, outcome: 'refused', reason: item.reason, message: null }); continue; }
      // What the gateway cannot tell apart by an identity is compared here, so a second move adds nothing twice.
      if (item.kind === 'endpoint') {
        const same = before.find(account => account.provider === 'openai_compatible' && account.route === item.route);
        if (same) {
          const present = typeof same.base_url === 'string' && same.base_url.replace(/\/+$/, '') === item.baseUrl;
          outcomes.push({ id, outcome: present ? 'present' : 'refused', reason: present ? null : 'routeTaken', message: null });
          continue;
        }
      } else if (item.kind !== 'login') {
        if (before.some(account => account.provider === SUBSCRIPTION_OF[item.kind])) { outcomes.push({ id, outcome: 'present', reason: null, message: null }); continue; }
      } else if (entry.identity) {
        // A login Douane already holds is its own fresher copy: Boite's could carry a refresh token Douane already rotated.
        const provider = LOGIN_FILES[item.providerId];
        if (before.some(account => account.provider === provider && typeof account.email === 'string' && account.email.toLowerCase() === entry.identity!.toLowerCase())) {
          outcomes.push({ id, outcome: 'present', reason: null, message: null });
          continue;
        }
      }
      let payload: Record<string, unknown>;
      try { payload = entry.payload(); }
      catch { outcomes.push({ id, outcome: 'refused', reason: 'unreadable', message: null }); continue; }
      const secrets = secretsOf(payload);
      try {
        const answer = await gatewayCall(core, proxy, secret, '/accounts/import', { files: [{ content: payload }] });
        const accounts = Array.isArray(answer.json.accounts) ? answer.json.accounts.map(record) : [];
        const errors = Array.isArray(answer.json.errors) ? answer.json.errors.map(record) : [];
        const taken = accounts[0];
        if (answer.status < 300 && taken && typeof taken.id === 'string') {
          outcomes.push({ id, outcome: before_ids.has(taken.id) ? 'present' : 'moved', reason: null, message: null });
          before_ids.add(taken.id);
          before.push(taken as GatewayAccount);
        } else {
          const said = errors[0]?.error ?? answer.json.error;
          outcomes.push({ id, outcome: 'refused', reason: null, message: scrub(typeof said === 'string' && said ? said : `HTTP ${answer.status}`, secrets) });
        }
      } catch (error) {
        assertGateway(core, proxy);
        const message = error instanceof RpcFailure || error instanceof Error ? error.message : String(error);
        outcomes.push({ id, outcome: 'refused', reason: null, message: scrub(message, secrets) });
      }
    }
    const moved = outcomes.filter(outcome => outcome.outcome === 'moved').length;
    core.log('info', `subscription proxy: moved ${moved} of ${outcomes.length} logins to Douane at ${subscriptionProxyOrigin(proxy)}`);
    return { outcomes };
  } finally { moving.delete(core); }
}

export function registerGatewayMove(core: Core): void {
  core.router.register('subscriptionProxy.movePlan', (params) => movePlan(core, params?.target));
  core.router.register('subscriptionProxy.move', ({ ids, managementToken: token, target }) => moveToGateway(core, ids, token, target));
}
