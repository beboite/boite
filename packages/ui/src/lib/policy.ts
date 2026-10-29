import type { AdminPolicy, PolicyKey, PolicyState } from '@boite/contracts';

/**
 * What the admin policy a core enforces locks, read by the controls that
 * show it. The core refuses what the policy forbids whatever the UI draws;
 * these only say why a control is off before the user tries it.
 */

/** The first of `keys` the policy holds, or null when it leaves them all to the user. */
export function lockedBy(policy: PolicyState | null | undefined, ...keys: PolicyKey[]): PolicyKey | null {
  if (!policy?.present) return null;
  return keys.find((key) => policy.locked.includes(key)) ?? null;
}

/** The value a key holds in the policy, as the file says it once validated. */
export function policyValue(values: AdminPolicy, key: PolicyKey): unknown {
  switch (key) {
    case 'gateway': return typeof values.gateway === 'object' ? true : values.gateway;
    case 'gateway.allowedBaseUrls': return typeof values.gateway === 'object' ? values.gateway.allowedBaseUrls : undefined;
    case 'agentBrowser': return typeof values.agentBrowser === 'object' ? true : values.agentBrowser;
    case 'agentBrowser.searchUrl': return typeof values.agentBrowser === 'object' ? values.agentBrowser.searchUrl : undefined;
    default: {
      const [head, tail] = key.split('.') as [keyof AdminPolicy, string | undefined];
      const top = values[head] as unknown;
      return tail === undefined ? top : (top as Record<string, unknown> | undefined)?.[tail];
    }
  }
}

/** True when the policy forbids a provider: the core keeps it off and says which key. */
export function providerBlocked(policy: PolicyState | null | undefined, id: string): PolicyKey | null {
  const providers = policy?.present ? policy.values.providers : undefined;
  if (providers?.allow !== undefined && !providers.allow.includes(id)) return 'providers.allow';
  if (providers?.deny?.includes(id)) return 'providers.deny';
  return null;
}

/** The address-bar search the policy sets, `{query}` where the typed text goes; null leaves the default. */
export function policySearch(policy: PolicyState | null | undefined): string | null {
  return policy?.present && typeof policy.values.agentBrowser === 'object' ? policy.values.agentBrowser.searchUrl : null;
}

/** The core's URL form for a gateway address: origin and path, no trailing slash, http(s) without credentials. */
function gatewayUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/** The core's `gatewayBlock` over policy values: every gateway off, or `baseUrl` outside the allowed ones. */
export function gatewayBlockOf(values: AdminPolicy, baseUrl?: string | null): 'gateway' | 'gateway.allowedBaseUrls' | null {
  if (values.gateway === false) return 'gateway';
  if (typeof values.gateway !== 'object' || typeof baseUrl !== 'string') return null;
  const url = gatewayUrl(baseUrl);
  const allowed = values.gateway.allowedBaseUrls;
  return url !== null && allowed.some((item) => url === item || url.startsWith(`${item}/`)) ? null : 'gateway.allowedBaseUrls';
}

/** The key that keeps a gateway at `baseUrl` from being turned on, or null. */
export function gatewayBlocked(policy: PolicyState | null | undefined, baseUrl?: string | null): 'gateway' | 'gateway.allowedBaseUrls' | null {
  return policy?.present ? gatewayBlockOf(policy.values, baseUrl) : null;
}
