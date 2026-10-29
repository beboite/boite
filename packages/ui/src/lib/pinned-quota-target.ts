import { subscriptionProxyOf, type AccountQuota, type ProviderSummary, type Settings } from '@boite/contracts';

/** The upstream route wins over names inside it: openrouter/anthropic/claude is OpenRouter. */
function gatewayProvider(model: string | null, provider: Pick<ProviderSummary, 'id' | 'protocol'>): string | null {
  let route = model?.trim().toLowerCase() ?? '';
  while (/^(douane|cliproxyapi)\//.test(route)) route = route.slice(route.indexOf('/') + 1);
  const slash = route.indexOf('/');
  if (slash > 0) return route.slice(0, slash);
  if (/^(claude|opus|sonnet|haiku)(?:$|[-\s.\d])/.test(route)) return 'claude';
  if (/^(gpt|codex)(?:$|[-\s.\d])/.test(route)) return 'codex';
  if (/^gemini(?:$|[-\s.\d])/.test(route)) return 'antigravity';
  if (/^grok(?:$|[-\s.\d])/.test(route)) return 'grok';
  if (route) return null;
  if (provider.protocol === 'claude-sdk') return 'claude';
  if (provider.protocol === 'codex-appserver') return 'codex';
  return provider.id === 'grok' ? 'grok' : null;
}

/** All visible accounts for the selected model's source, without mixing gateway and local readings. */
export function pinnedQuotaRows(
  rows: AccountQuota[],
  choice: { providerId: string; model: string | null } | null,
  provider: Pick<ProviderSummary, 'id' | 'protocol'> | null,
  settings: Pick<Settings, 'subscriptionProxy'> | null,
): AccountQuota[] {
  if (!choice || !provider || choice.providerId !== provider.id) return [];
  const proxy = subscriptionProxyOf(settings, provider);
  const openCode = provider.id === 'opencode' || provider.id === 'opencode-v2';
  // OpenCode also serves its own catalog while a gateway is configured.
  const gatewayModel = /^(douane|cliproxyapi)\//i.test(choice.model?.trim() ?? '');
  if (!proxy || (openCode && !gatewayModel)) {
    return rows.filter(row => !row.gateway && row.providerId === choice.providerId);
  }
  const upstream = gatewayProvider(choice.model, provider);
  return rows.filter(row => row.gateway?.kind === proxy.kind && row.providerId === upstream);
}
