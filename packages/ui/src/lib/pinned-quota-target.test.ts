import { expect, test } from 'vitest';
import type { AccountQuota, ProviderSummary, Settings } from '@boite/contracts';
import { pinnedQuotaRows } from './pinned-quota-target';

const claude: Pick<ProviderSummary, 'id' | 'protocol'> = { id: 'claude', protocol: 'claude-sdk' };
const codex: Pick<ProviderSummary, 'id' | 'protocol'> = { id: 'codex', protocol: 'codex-appserver' };
const proxy: Pick<Settings, 'subscriptionProxy'> = {
  subscriptionProxy: { enabled: true, kind: 'douane', baseUrl: 'https://gateway.test', dashboardUrl: 'https://gateway.test' },
};

function row(providerId: string, accountId: string, kind?: 'douane' | 'cliproxyapi'): AccountQuota {
  return {
    providerId, accountId, providerName: providerId, label: accountId,
    enabled: true, status: 'ready', checkedAt: null, error: null, windows: [],
    ...(kind ? { gateway: { kind, entryId: accountId, display: 'accounts' as const, plan: null, accounts: 1, status: 'ready' as const, credits: [] } } : {}),
  };
}

const localClaude = [row('claude', 'local-a'), row('claude', 'local-b')];
const gatewayClaude = [row('claude', 'gateway-a', 'douane'), row('claude', 'gateway-b', 'douane')];
const gatewayCodex = row('codex', 'gateway-codex', 'douane');
const gatewayGemini = row('antigravity', 'gateway-gemini', 'douane');
const rows = [...localClaude, row('codex', 'local-codex'), ...gatewayClaude, gatewayCodex, gatewayGemini];

test('direct Claude keeps every account and excludes gateway rows', () => {
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'opus' }, claude, null)).toEqual(localClaude);
});

test('split Claude accounts follow the selected upstream, then switch together to Codex', () => {
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'claude/opus-5.5' }, claude, proxy)).toEqual(gatewayClaude);
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'codex/gpt-6.1' }, claude, proxy)).toEqual([gatewayCodex]);
});

test.each(['opus', 'Sonnet 5', 'haiku', 'claude-opus-5-5'])(
  'bare Claude alias %s selects all Claude gateway accounts', model => {
    expect(pinnedQuotaRows(rows, { providerId: 'codex', model }, codex, proxy)).toEqual(gatewayClaude);
  },
);

test.each(['gpt-6.1', 'codex'])(
  'bare Codex alias %s selects the Codex gateway accounts', model => {
    expect(pinnedQuotaRows(rows, { providerId: 'claude', model }, claude, proxy)).toEqual([gatewayCodex]);
  },
);

test.each(['gemini-3-pro', 'antigravity/gemini-3-pro', 'antigravity/claude-opus-5-5'])(
  'Antigravity route %s keeps its own subscription', model => {
    expect(pinnedQuotaRows(rows, { providerId: 'claude', model }, claude, proxy)).toEqual([gatewayGemini]);
  },
);

test.each(['douane/claude/opus', 'cliproxyapi/claude/opus', 'douane/cliproxyapi/claude/opus'])(
  'gateway wrapper %s preserves the upstream route', model => {
    expect(pinnedQuotaRows(rows, { providerId: 'claude', model }, claude, proxy)).toEqual(gatewayClaude);
  },
);

test.each(['openrouter/anthropic/claude-opus', 'custom/claude-opus', 'douane/custom/claude-opus'])(
  'paid route %s never borrows Claude subscription quotas', model => {
    expect(pinnedQuotaRows(rows, { providerId: 'claude', model }, claude, proxy)).toEqual([]);
  },
);

test('an explicit custom route can select its own gateway quota', () => {
  const custom = row('custom', 'custom-subscription', 'douane');
  expect(pinnedQuotaRows([...rows, custom], { providerId: 'claude', model: 'custom/claude-opus' }, claude, proxy)).toEqual([custom]);
});

test.each(['opencode', 'opencode-v2'])(
  'direct %s keeps its OpenCode Go quotas even with an Anthropic model and enabled gateway', id => {
    const provider: Pick<ProviderSummary, 'id' | 'protocol'> = { id, protocol: 'acp' };
    const locals = [row(id, 'go-a'), row(id, 'go-b')];
    const all = [...rows, ...locals];
    expect(pinnedQuotaRows(all, { providerId: id, model: 'anthropic/claude-opus' }, provider, proxy)).toEqual(locals);
    expect(pinnedQuotaRows(all, { providerId: id, model: 'claude/opus' }, provider, proxy)).toEqual(locals);
    expect(pinnedQuotaRows(all, { providerId: id, model: 'douane/claude/opus' }, provider, proxy)).toEqual(gatewayClaude);
  },
);

test('wrapped OpenCode Go and Grok routes select their upstream quota rows', () => {
  const go = row('opencode_go', 'go', 'douane');
  const grok = row('grok', 'grok', 'douane');
  for (const [model, expected] of [['douane/opencode_go/kimi-k3', go], ['grok/grok-4', grok]] as const) {
    expect(pinnedQuotaRows([...rows, go, grok], { providerId: 'claude', model }, claude, proxy)).toEqual([expected]);
  }
});

test('an enabled proxy without a matching native quota never falls back to local accounts', () => {
  expect(pinnedQuotaRows(localClaude, { providerId: 'claude', model: 'opus' }, claude, proxy)).toEqual([]);
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'unknown-model' }, claude, proxy)).toEqual([]);
});

test('only the enabled gateway kind supplies quota rows', () => {
  const other = row('claude', 'other-gateway', 'cliproxyapi');
  const settings = { subscriptionProxy: { ...proxy.subscriptionProxy!, kind: 'cliproxyapi' as const } };
  expect(pinnedQuotaRows([...rows, other], { providerId: 'claude', model: 'opus' }, claude, settings)).toEqual([other]);
});

test('a disabled gateway restores local quotas', () => {
  const settings = { subscriptionProxy: { ...proxy.subscriptionProxy!, enabled: false } };
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'opus' }, claude, settings)).toEqual(localClaude);
});

test('no choice or no matching provider summary selects nothing', () => {
  expect(pinnedQuotaRows(rows, null, claude, proxy)).toEqual([]);
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'opus' }, null, proxy)).toEqual([]);
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: 'opus' }, codex, proxy)).toEqual([]);
});

test('a provider default without a model uses its gateway subscription', () => {
  expect(pinnedQuotaRows(rows, { providerId: 'claude', model: null }, claude, proxy)).toEqual(gatewayClaude);
  expect(pinnedQuotaRows(rows, { providerId: 'codex', model: null }, codex, proxy)).toEqual([gatewayCodex]);
});

test('an ACP provider outside the proxy contract keeps its local quotas', () => {
  const provider: Pick<ProviderSummary, 'id' | 'protocol'> = { id: 'custom-acp', protocol: 'acp' };
  const local = row(provider.id, 'custom-local');
  expect(pinnedQuotaRows([...rows, local], { providerId: provider.id, model: 'claude/opus' }, provider, proxy)).toEqual([local]);
});

test('Grok uses Douane, while a gateway kind that cannot serve it keeps its local quota', () => {
  const provider: Pick<ProviderSummary, 'id' | 'protocol'> = { id: 'grok', protocol: 'acp' };
  const local = row('grok', 'grok-local');
  const gateway = row('grok', 'grok-gateway', 'douane');
  const all = [local, gateway];
  const choice = { providerId: 'grok', model: 'grok-4' };
  expect(pinnedQuotaRows(all, choice, provider, proxy)).toEqual([gateway]);
  const settings = { subscriptionProxy: { ...proxy.subscriptionProxy!, kind: 'cliproxyapi' as const } };
  expect(pinnedQuotaRows(all, choice, provider, settings)).toEqual([local]);
});
