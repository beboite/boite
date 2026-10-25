import type { SubscriptionProxyQuotas } from './accounts';
import type { AccountId, ProviderId } from './ids';
import type { GatewayMoveTarget } from './plugins';
import type { Protocol } from './providers';
import type { Settings } from './settings';

export interface SubscriptionProxy {
  enabled: boolean;
  kind: 'douane' | 'cliproxyapi';
  /** HTTP(S) API root, with or without its /v1 suffix. */
  baseUrl: string;
  /** User-facing quotas page, opened inside Boite. Never contains a token. */
  dashboardUrl: string;
  /**
   * Where the gateway runs. Missing or `remote`: at the URLs above, which the
   * user typed. `local`: the Douane plugin this core runs (`provides.gateway`,
   * docs/plugins.md); the kind is `douane` and the core writes both URLs from
   * the plugin's loopback port.
   */
  mode?: SubscriptionProxyMode;
}

export type SubscriptionProxyMode = 'remote' | 'local';

/** The protocols whose every agent a subscription proxy serves. */
export const SUBSCRIPTION_PROXY_PROTOCOLS: readonly Protocol[] = ['claude-sdk', 'codex-appserver'];
/**
 * The providers a subscription proxy serves by id, where the protocol cannot
 * say: both OpenCode versions take the gateway as one more model provider,
 * while other ACP agents keep their own configuration.
 */
export const SUBSCRIPTION_PROXY_PROVIDERS: readonly ProviderId[] = ['opencode', 'opencode-v2'];
/**
 * The providers only one kind of gateway serves. Grok's CLI takes its models
 * from the gateway's own list, and Douane writes that list the way the CLI
 * reads it: xAI's ids in xAI's order, each with its window and efforts.
 */
export const SUBSCRIPTION_PROXY_KIND_PROVIDERS: Readonly<Record<SubscriptionProxy['kind'], readonly ProviderId[]>> = {
  douane: ['grok'],
  cliproxyapi: [],
};

/** What tells whether a proxy serves a provider: its id and its protocol, as a descriptor and a summary both carry them. */
export type SubscriptionProxyTarget = { id: ProviderId; protocol: Protocol };

/**
 * Whether a subscription proxy serves this provider: one of that kind, or one
 * of either kind when none is named. Core and clients decide alike.
 */
export function subscriptionProxyServes(provider: SubscriptionProxyTarget | null | undefined, kind?: SubscriptionProxy['kind'], quotas?: Pick<SubscriptionProxyQuotas, 'providers' | 'nativeMuse'> | null): boolean {
  if (provider === null || provider === undefined) return false;
  // Muse's native subscription is a distinct Meta pool; an OpenCode Go Muse model does not connect it.
  if (provider.id === 'muse') return kind === 'douane' && quotas?.nativeMuse === true && quotas.providers.some(pool => pool.providerId === 'meta' && pool.entries.some(entry => entry.status !== 'disabled'));
  if (SUBSCRIPTION_PROXY_PROTOCOLS.includes(provider.protocol) || SUBSCRIPTION_PROXY_PROVIDERS.includes(provider.id)) return true;
  const kinds = kind === undefined ? Object.values(SUBSCRIPTION_PROXY_KIND_PROVIDERS) : [SUBSCRIPTION_PROXY_KIND_PROVIDERS[kind]];
  return kinds.some((ids) => ids.includes(provider.id));
}

/** The enabled proxy that serves this provider, or null. */
export function subscriptionProxyOf(settings: Pick<Settings, 'subscriptionProxy'> | null | undefined, provider: SubscriptionProxyTarget | null | undefined, quotas?: Pick<SubscriptionProxyQuotas, 'providers' | 'nativeMuse'> | null): SubscriptionProxy | null {
  const proxy = settings?.subscriptionProxy;
  return proxy?.enabled && subscriptionProxyServes(provider, proxy.kind, quotas) ? proxy : null;
}

export function subscriptionProxyName(kind: SubscriptionProxy['kind']): string {
  return kind === 'douane' ? 'Douane' : 'CLIProxyAPI';
}

/** The gateway's address as a person reads it: the API URL's origin. */
export function subscriptionProxyOrigin(proxy: SubscriptionProxy): string {
  // No `URL` here: contracts build without DOM or Node types. Credentials in the address never show.
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#@]*@)?([^/?#@]+)/i.exec(proxy.baseUrl);
  return match ? `${match[1]}${match[2]}`.toLowerCase() : proxy.baseUrl;
}

/**
 * Whether a client can open the gateway's dashboard: a loopback address only
 * answers on the core's own machine, so a phone or another computer gets no
 * dead link. `sameMachine` says the client runs where the core does.
 */
export function gatewayDashboardReachable(dashboardUrl: string | null | undefined, sameMachine: boolean): boolean {
  if (!dashboardUrl) return false;
  const match = /^https?:\/\/(?:[^/?#@]*@)?(\[[^\]]+\]|[^/?#:]+)/i.exec(dashboardUrl);
  if (!match) return false;
  return sameMachine || !isLoopbackHost(match[1]!);
}

/** `localhost`, `127.x.y.z`, `::1` and the IPv4-mapped loopback. */
export function isLoopbackHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(name)
    || name === '::1' || /^(?:0:){5}ffff:127\./.test(name) || /^::ffff:127\./.test(name);
}

/**
 * What a move to Douane takes from one Boite account. `login`: the agent's
 * own sign-in file (Claude, Codex, Grok). `copilot`: OpenCode's GitHub Copilot
 * sign-in. `endpoint`: an OpenCode API key, served by Douane as a custom
 * endpoint under `route`. `opencodeGo`: OpenCode Go's key, Douane's own
 * `opencode_go` subscription.
 */
export type GatewayMoveKind = 'login' | 'copilot' | 'endpoint' | 'opencodeGo';

/**
 * Why an item cannot move. `signedOut`: no login file. `unreadable`: the file
 * is not JSON. `noAddress`: OpenCode's catalog gives the key no API address.
 * `otherApi`: the provider does not speak the OpenAI API. `otherSignIn`: an
 * OpenCode sign-in Douane cannot take (only GitHub Copilot's). `routeTaken`:
 * the gateway already serves another address under that endpoint's route.
 */
export type GatewayMoveReason = 'signedOut' | 'unreadable' | 'noAddress' | 'otherApi' | 'otherSignIn' | 'routeTaken';

export interface GatewayMoveItem {
  /** Stable while the files do not change: `subscriptionProxy.move` names items by it. */
  id: string;
  accountId: AccountId;
  providerId: ProviderId;
  kind: GatewayMoveKind;
  /** OpenCode's provider for a key or a sign-in: its id and its catalog name. */
  source?: { id: string; name: string };
  /** An endpoint's route at the gateway and its upstream address. */
  route?: string;
  baseUrl?: string;
  movable: boolean;
  reason: GatewayMoveReason | null;
}

/** `subscriptionProxy.movePlan`: what this machine could move, read from its files. No credential value. */
export interface GatewayMovePlan {
  /** The configured Douane's address as a person reads it, null when no Douane is configured. */
  origin: string | null;
  /** A management token for the gateway's `/admin/api` is saved on the core. */
  managementToken: boolean;
  items: GatewayMoveItem[];
}

/**
 * One item's result. `moved`: the gateway took it. `present`: the gateway
 * already had it; a sign-in it already had is updated with this copy.
 * `refused`: the gateway said no (`message` is its reason) or the item cannot
 * move (`reason`). `missing`: no such item any more.
 */
export interface GatewayMoveOutcome {
  id: string;
  outcome: 'moved' | 'present' | 'refused' | 'missing';
  reason: GatewayMoveReason | null;
  message: string | null;
}

export interface SubscriptionProxyRpcMethods {
  'subscriptionProxy.key': { params: { key: string | null }; result: { configured: boolean } };
  /** Owner-only, atomic configuration and optional private-key update; an omitted key keeps it. */
  'subscriptionProxy.configure': { params: { subscriptionProxy: SubscriptionProxy; key?: string | null }; result: Settings };
  /**
   * Turns the configured gateway on or off and nothing else: its kind, URLs
   * and key stay as the owner saved them. A paired phone may call it.
   */
  'subscriptionProxy.setEnabled': { params: { enabled: boolean }; result: Settings };
  /** Owner-only. The core reads the gateway's quotas route itself; `quotas.list` carries the same entries. */
  'subscriptionProxy.quotas': { params: { refresh?: boolean }; result: SubscriptionProxyQuotas };
  /** Owner-only. The logins and OpenCode keys of this machine's accounts Douane could take, without their values. */
  'subscriptionProxy.movePlan': { params: { target?: GatewayMoveTarget }; result: GatewayMovePlan };
  /**
   * Owner-only. The core reads each named item's file and posts it to the
   * configured Douane's `/admin/api/accounts/import`. `managementToken` saves
   * (or with null removes) the token sent to that API; omitted keeps it.
   */
  'subscriptionProxy.move': { params: { ids: string[]; managementToken?: string | null; target?: GatewayMoveTarget }; result: { outcomes: GatewayMoveOutcome[] } };
}

export interface SubscriptionProxyRpcEvents {
  /** Owner-only. Every answer or failure of the gateway's quotas route, whoever asked. */
  'subscriptionProxy.quotasUpdated': SubscriptionProxyQuotas;
}
