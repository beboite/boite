import { RpcErrorCode, type RpcMethodName, type AccountQuota, type AdminPolicy, type PolicyKey, type PolicyProblem, type PolicyState, type ProviderSummary, type Settings } from '@boite/contracts';
import { RpcFailure } from '../client';
import { gatewayBlockOf, providerBlocked } from '../policy';
import type { FakeContext } from './context';

/**
 * The in-memory core's admin policy. `?fake=1&policy=managed` locks one value
 * of every key a screen shows, `policy=broken` reads a file with a bad value
 * and an unknown key, `policy=closed` one that does not parse: what the
 * screens draw for each, without a real `/etc/boite/policy.json`.
 */

const FILE = '/etc/boite/policy.json';

/** Every key a control shows, locked. Same shape as the core's `readPolicy` answer. */
export const MANAGED_POLICY: AdminPolicy = {
  analytics: 'basic',
  updates: { app: 'check', server: 'off', agents: 'off' },
  providers: { deny: ['grok'] },
  gateway: false,
  quotaReads: false,
  plugins: { install: false, recommended: false },
  issueReports: false,
  dictation: 'local',
  agentBrowser: { searchUrl: 'https://search.example.com/?q={query}' },
  network: { lan: false, tailscaleServe: false, groups: false, contacts: false, push: false },
  pullRequests: false
};

/** The core's strictest value of every key, what a file that does not parse gets. */
const STRICTEST: AdminPolicy = {
  analytics: 'off',
  updates: { app: 'off', server: 'off', agents: 'off' },
  providers: { allow: [] },
  gateway: false,
  quotaReads: false,
  plugins: { install: false, recommended: false },
  issueReports: false,
  dictation: 'off',
  previews: { remoteResources: false },
  agentBrowser: false,
  network: { lan: false, tailscaleServe: false, groups: false, contacts: false, push: false },
  pullRequests: false
};

/** The keys `values` locks, in the contract's order, as the core's `lockedKeys`. */
export function lockedKeysOf(values: AdminPolicy): PolicyKey[] {
  const on: PolicyKey[] = [];
  if (values.analytics !== undefined) on.push('analytics');
  for (const kind of ['app', 'server', 'agents'] as const) if (values.updates?.[kind] !== undefined) on.push(`updates.${kind}`);
  if (values.providers?.allow !== undefined) on.push('providers.allow');
  if (values.providers?.deny !== undefined) on.push('providers.deny');
  if (values.gateway === false) on.push('gateway');
  if (typeof values.gateway === 'object') on.push('gateway.allowedBaseUrls');
  if (values.quotaReads === false) on.push('quotaReads');
  if (values.plugins?.install === false) on.push('plugins.install');
  if (values.plugins?.recommended === false) on.push('plugins.recommended');
  if (values.issueReports === false) on.push('issueReports');
  if (values.dictation !== undefined) on.push('dictation');
  if (values.previews?.remoteResources === false) on.push('previews.remoteResources');
  if (values.agentBrowser === false) on.push('agentBrowser');
  if (typeof values.agentBrowser === 'object') on.push('agentBrowser.searchUrl');
  for (const item of ['lan', 'tailscaleServe', 'groups', 'contacts', 'push'] as const) if (values.network?.[item] === false) on.push(`network.${item}`);
  if (values.pullRequests === false) on.push('pullRequests');
  return on;
}

/** A policy state for `values`, as `policy.get` answers it. */
export function fakePolicy(values: AdminPolicy | null, problems: PolicyProblem[] = [], failedClosed = false): PolicyState {
  if (values === null) return { file: FILE, present: false, values: {}, locked: [], problems: [], failedClosed: false, readAt: 0 };
  return { file: FILE, present: true, values: structuredClone(values), locked: lockedKeysOf(values), problems, failedClosed, readAt: 0 };
}

/** The fixture `?policy=` names; none without it, as on most machines. */
export function policyFixture(kind: string | null): PolicyState {
  switch (kind) {
    case 'managed': return fakePolicy(MANAGED_POLICY);
    case 'broken': return fakePolicy({ ...MANAGED_POLICY, updates: { ...MANAGED_POLICY.updates, app: 'off' } }, [
      { file: FILE, field: 'updates.app', expected: '"off" or "check" or "auto"', message: `${FILE}: updates.app is "weekly"; expected "off" or "check" or "auto"` },
      { file: FILE, field: 'telemetry', expected: 'one of analytics, updates, providers, gateway, quotaReads, plugins, issueReports, dictation, previews, agentBrowser, network, pullRequests', message: `${FILE}: telemetry is an unknown key` }
    ]);
    case 'closed': return fakePolicy(STRICTEST, [
      { file: FILE, field: '(file)', expected: 'a JSON object', message: `${FILE}: not valid JSON (Unexpected token } in JSON at position 212); every policy key takes its strictest value until it is fixed` }
    ], true);
    default: return fakePolicy(null);
  }
}

/** The settings the policy decides, read over the user's: the core's `lockedSettings`. */
export function lockedSettingsOf(values: AdminPolicy, settings: Settings): Partial<Settings> {
  const locked: Partial<Settings> = {};
  if (values.network?.lan === false) locked.listenOnLan = false;
  if (values.updates?.app !== undefined) locked.autoInstallUpdates = values.updates.app === 'auto';
  if (values.updates?.agents !== undefined) locked.autoUpdateHarnesses = values.updates.agents === 'auto';
  if (values.network?.groups === false) { locked.groupThreads = false; locked.groupBots = false; }
  if (settings.subscriptionProxy?.enabled && gatewayBlockOf(values, settings.subscriptionProxy.baseUrl) !== null) locked.subscriptionProxy = { ...settings.subscriptionProxy, enabled: false };
  return locked;
}

const SETTING_KEYS: Partial<Record<keyof Settings, PolicyKey>> = {
  listenOnLan: 'network.lan', autoInstallUpdates: 'updates.app', autoUpdateHarnesses: 'updates.agents', groupThreads: 'network.groups', groupBots: 'network.groups'
};

/** What each key forbids, the start of the core's refusal. */
const FORBIDS: Record<PolicyKey, string> = {
  analytics: 'Usage analytics', 'updates.app': 'Desktop app updates', 'updates.server': 'Server updates', 'updates.agents': 'Agent updates',
  'providers.allow': 'This provider', 'providers.deny': 'This provider', gateway: 'The subscription gateway', 'gateway.allowedBaseUrls': 'This gateway address',
  quotaReads: 'Quota reads', 'plugins.install': 'Plugin installs', 'plugins.recommended': 'Recommended plugin checks', issueReports: 'Issue reports',
  dictation: 'Dictation', 'previews.remoteResources': 'Remote resources in previews', agentBrowser: 'The agent browser', 'agentBrowser.searchUrl': 'This search address',
  'network.lan': 'Listening on the local network', 'network.tailscaleServe': 'Tailscale HTTPS serving', 'network.groups': 'Groups', 'network.contacts': 'Contacts',
  'network.push': 'Push notifications', pullRequests: 'Pull request reads'
};

/** The core's refusal of a key the policy forbids, with the same message and data. */
export function policyRefusal(ctx: FakeContext, key: PolicyKey, detail?: string): RpcFailure {
  return new RpcFailure({ code: RpcErrorCode.Refused, message: `${FORBIDS[key]}${detail ? ` (${detail})` : ''}: blocked by your organization's policy, key ${key} in ${ctx.policy.file}`, data: { policy: key, file: ctx.policy.file } });
}

/** Throws the core's refusal when a settings patch changes what the policy locks. */
export function checkPolicySettings(ctx: FakeContext, patch: Partial<Settings>): void {
  if (!ctx.policy.present) return;
  const locked = lockedSettingsOf(ctx.policy.values, { ...ctx.settings, ...patch });
  for (const [setting, key] of Object.entries(SETTING_KEYS) as [keyof Settings, PolicyKey][]) {
    if (setting in patch && setting in locked && (patch[setting] === true) !== (locked[setting] === true)) throw policyRefusal(ctx, key);
  }
  const proxy = patch.subscriptionProxy;
  const gateway = proxy?.enabled ? gatewayBlockOf(ctx.policy.values, proxy.baseUrl) : null;
  if (gateway !== null) throw policyRefusal(ctx, gateway);
}

/** Applies the policy to what the fake core holds: locked settings, a capped analytics mode and the blocked providers. */
export function applyPolicy(ctx: FakeContext): void {
  const values = ctx.policy.present ? ctx.policy.values : {};
  ctx.settings = { ...ctx.settings, ...lockedSettingsOf(values, ctx.settings) };
  if (values.analytics === 'off') ctx.telemetry = { ...ctx.telemetry, mode: 'off' };
  if (values.analytics === 'basic' && ctx.telemetry.mode === 'enhanced') ctx.telemetry = { ...ctx.telemetry, mode: 'basic' };
  markBlockedProviders(ctx, ctx.providers);
}

/** Marks each provider the policy keeps off, as the core's loader does: off, with the key and the file. */
export function markBlockedProviders(ctx: FakeContext, providers: ProviderSummary[]): ProviderSummary[] {
  for (const provider of providers) {
    const key = providerBlocked(ctx.policy, provider.id);
    if (key) { provider.enabled = false; provider.policy = { policy: key, file: ctx.policy.file }; }
    else if (provider.policy) { delete provider.policy; }
  }
  return providers;
}

/** The core's quota row when `quotaReads` is false: a row it would read stands disabled, saying why, with nothing read. */
export function quotaReadBlocked(ctx: FakeContext, row: AccountQuota): AccountQuota {
  if (!ctx.policy.present || ctx.policy.values.quotaReads !== false || !row.enabled || row.status === 'unsupported') return row;
  const { resetCredits: _resets, credits: _credits, ...rest } = row;
  return { ...rest, status: 'disabled', windows: [], checkedAt: null, error: policyRefusal(ctx, 'quotaReads').message };
}

type Rule = (values: AdminPolicy, params: Record<string, unknown>, ctx: FakeContext) => PolicyKey | null;
const when = (key: PolicyKey, blocked: (values: AdminPolicy, params: Record<string, unknown>) => boolean): Rule => (values, params) => blocked(values, params) ? key : null;
const net = (item: 'lan' | 'tailscaleServe' | 'groups' | 'contacts' | 'push'): Rule => when(`network.${item}`, values => values.network?.[item] === false);
const provider: Rule = (_values, params, ctx) => typeof params.providerId === 'string' ? providerBlocked(ctx.policy, params.providerId) : null;
const gatewayOff = (values: AdminPolicy) => values.gateway === false;
const plugins = when('plugins.install', values => values.plugins?.install === false);
const dictationOff = when('dictation', values => values.dictation === 'off');
const browserOff = when('agentBrowser', values => values.agentBrowser === false);
const pullRequestsOff = when('pullRequests', values => values.pullRequests === false);
const updatesOff = (values: AdminPolicy, kind: 'app' | 'server' | 'agents') => values.updates?.[kind] === 'off';

/** The core's RPC gate (`policy-gate.ts`), rule for rule. */
const RULES: Partial<Record<RpcMethodName, Rule>> = {
  'telemetry.configure': (values, params) => (values.analytics === 'off' && params.mode !== 'off') || (values.analytics === 'basic' && params.mode === 'enhanced') ? 'analytics' : null,
  'telemetry.export': when('analytics', values => values.analytics === 'off'),
  'telemetry.retryForget': when('analytics', values => values.analytics === 'off'),
  'core.updateInstall': when('updates.server', values => updatesOff(values, 'server')),
  'core.updateEverything': (values, params) => {
    if (Array.isArray(params.agents) && params.agents.length > 0 && updatesOff(values, 'agents')) return 'updates.agents';
    if (params.server !== undefined && params.server !== null && updatesOff(values, 'server')) return 'updates.server';
    if (params.app !== undefined && params.app !== null && updatesOff(values, 'app')) return 'updates.app';
    return null;
  },
  'providers.update': (values, params, ctx) => updatesOff(values, 'agents') ? 'updates.agents' : provider(values, params, ctx),
  'providers.install': provider,
  'providers.probe': provider,
  'providers.dryRun': provider,
  'providers.setEnabled': (values, params, ctx) => params.enabled === true ? provider(values, params, ctx) : null,
  'subscriptionProxy.configure': (values, params) => {
    const proxy = params.subscriptionProxy as Settings['subscriptionProxy'];
    if (gatewayOff(values)) return proxy?.enabled || (params.key !== undefined && params.key !== null) ? 'gateway' : null;
    return proxy?.enabled ? gatewayBlockOf(values, proxy.baseUrl) : null;
  },
  'subscriptionProxy.setEnabled': (values, params, ctx) => params.enabled === true ? gatewayBlockOf(values, ctx.settings.subscriptionProxy?.baseUrl ?? null) : null,
  'subscriptionProxy.key': when('gateway', (values, params) => gatewayOff(values) && params.key !== null),
  'subscriptionProxy.quotas': when('gateway', gatewayOff),
  'subscriptionProxy.move': when('gateway', gatewayOff),
  'subscriptionProxy.movePlan': when('gateway', gatewayOff),
  'quotas.reset': when('quotaReads', values => values.quotaReads === false),
  'plugins.install': plugins,
  'plugins.add': plugins,
  'plugins.inspect': plugins,
  'diagnostics.issue': when('issueReports', values => values.issueReports === false),
  'speech.install': dictationOff,
  'speech.warm': dictationOff,
  'speech.streamStart': dictationOff,
  'push.subscribe': net('push'),
  'push.test': net('push'),
  'browser.command': browserOff,
  'browser.importCookies': browserOff,
  'browser.hostAttach': browserOff,
  'browser.hostReply': browserOff,
  'browser.remoteFrame': browserOff,
  'browser.remoteWatch': browserOff,
  'browser.remoteInput': browserOff,
  'browser.remoteSelection': browserOff,
  'tailscale.enable': net('tailscaleServe'),
  'group.create': net('groups'),
  'group.join': net('groups'),
  'group.invite': net('groups'),
  'group.ticket': net('groups'),
  'contacts.invite': net('contacts'),
  'contacts.join': net('contacts'),
  'contacts.grant': net('contacts'),
  'contacts.sendHuman': net('contacts'),
  'contacts.decide': when('network.contacts', (values, params) => params.accept === true && values.network?.contacts === false),
  'contacts.tailscaleKey': when('network.contacts', (values, params) => params.key !== null && values.network?.contacts === false),
  'threads.linkPullRequest': pullRequestsOff,
  'threads.watchPullRequest': pullRequestsOff,
};

/** The methods the fake gate holds a rule for: the parity test compares them with the core's. */
export const FAKE_GATED_METHODS = Object.keys(RULES) as RpcMethodName[];

/** Throws the core's refusal for a call the policy forbids. */
export function policyGate(ctx: FakeContext, method: RpcMethodName, params: unknown): void {
  if (!ctx.policy.present) return;
  const key = RULES[method]?.(ctx.policy.values, (params ?? {}) as Record<string, unknown>, ctx) ?? null;
  if (key !== null) throw policyRefusal(ctx, key);
}
