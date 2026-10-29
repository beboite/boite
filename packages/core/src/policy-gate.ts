/**
 * The admin policy at the RPC door. Every client, the `boite` CLI included,
 * reaches the core through the router, so a method a key forbids is refused
 * here with that key in the message, before its handler runs. What runs by
 * itself (timers, background reads) asks the policy where it reaches the
 * network; this map is only the door.
 */
import type { PolicyKey, RpcMethodName, Settings } from '@boite/contracts';
import type { Core } from './core.ts';

type Params = Record<string, unknown>;
/** The key a call breaks, with what it was about, or null to let it through. */
type Rule = (core: Core, params: Params) => [PolicyKey, string?] | null;

const when = (key: PolicyKey, test: (core: Core, params: Params) => boolean, detail?: (params: Params) => string): Rule =>
  (core, params) => (test(core, params) ? [key, detail?.(params)] : null);

const provider: Rule = (core, params) => {
  const id = typeof params.providerId === 'string' ? params.providerId : null;
  const key = id === null ? null : core.policy.providerBlock(id);
  return key === null ? null : [key, id ?? undefined];
};
const gatewayOff = (core: Core): boolean => core.policy.gatewayBlock() === 'gateway';
const gatewayAt = (core: Core, baseUrl: unknown): [PolicyKey, string?] | null => {
  const key = core.policy.gatewayBlock(typeof baseUrl === 'string' ? baseUrl : null);
  return key === null ? null : [key, key === 'gateway' ? undefined : String(baseUrl)];
};
const groupsOff = when('network.groups', core => core.policy.networkOff('groups'));
const contactsOff = when('network.contacts', core => core.policy.networkOff('contacts'));
const browserOff = when('agentBrowser', core => core.policy.agentBrowserOff());
const pullRequestsOff = when('pullRequests', core => core.policy.pullRequestsOff());
const dictationOff = when('dictation', core => core.policy.dictation() === 'off');
const pushOff = when('network.push', core => core.policy.networkOff('push'));
const pluginsOff = when('plugins.install', core => core.policy.pluginInstallsOff());
const updatesOff = (kind: 'app' | 'server' | 'agents') => (core: Core): boolean => core.policy.update(kind) === 'off';

const RULES: Partial<Record<RpcMethodName, Rule>> = {
  'telemetry.configure': (core, params) => {
    const ceiling = core.policy.analyticsCeiling();
    const mode = params.mode;
    if (ceiling === 'off' && mode !== 'off') return ['analytics', `mode ${String(mode)}`];
    if (ceiling === 'basic' && mode === 'enhanced') return ['analytics', 'mode enhanced; basic at most'];
    return null;
  },
  'telemetry.export': when('analytics', core => core.policy.analyticsCeiling() === 'off'),
  'telemetry.retryForget': when('analytics', core => core.policy.analyticsCeiling() === 'off'),

  'core.updateInstall': when('updates.server', updatesOff('server')),
  'core.updateEverything': (core, params) => {
    if (Array.isArray(params.agents) && params.agents.length > 0 && updatesOff('agents')(core)) return ['updates.agents'];
    if (params.server !== undefined && params.server !== null && updatesOff('server')(core)) return ['updates.server'];
    if (params.app !== undefined && params.app !== null && updatesOff('app')(core)) return ['updates.app'];
    return null;
  },
  'providers.update': (core, params) => (updatesOff('agents')(core) ? ['updates.agents'] : provider(core, params)),

  'providers.install': provider,
  'providers.probe': provider,
  'providers.dryRun': provider,
  'providers.setEnabled': (core, params) => (params.enabled === true ? provider(core, params) : null),

  'subscriptionProxy.configure': (core, params) => {
    const proxy = params.subscriptionProxy as Settings['subscriptionProxy'];
    // Saving it switched off, with no new key, stays possible as `setEnabled(false)` does.
    if (gatewayOff(core)) return proxy?.enabled || (params.key !== undefined && params.key !== null) ? ['gateway'] : null;
    return proxy?.enabled ? gatewayAt(core, proxy.baseUrl) : null;
  },
  'subscriptionProxy.setEnabled': (core, params) => (params.enabled === true ? gatewayAt(core, core.settings.stored().subscriptionProxy?.baseUrl ?? null) : null),
  'subscriptionProxy.key': when('gateway', (core, params) => gatewayOff(core) && params.key !== null),
  'subscriptionProxy.quotas': when('gateway', gatewayOff),
  'subscriptionProxy.move': when('gateway', gatewayOff),
  'subscriptionProxy.movePlan': when('gateway', gatewayOff),

  'quotas.reset': when('quotaReads', core => core.policy.quotaReadsOff()),

  'plugins.install': pluginsOff,
  'plugins.add': pluginsOff,
  'plugins.inspect': pluginsOff,

  'diagnostics.issue': when('issueReports', core => core.policy.issueReportsOff()),

  'speech.install': dictationOff,
  'speech.warm': dictationOff,
  'speech.streamStart': dictationOff,

  'push.subscribe': pushOff,
  'push.test': pushOff,

  'browser.command': browserOff,
  'browser.importCookies': browserOff,
  'browser.hostAttach': browserOff,
  'browser.hostReply': browserOff,
  'browser.remoteFrame': browserOff,
  'browser.remoteWatch': browserOff,
  'browser.remoteInput': browserOff,
  'browser.remoteSelection': browserOff,

  'tailscale.enable': when('network.tailscaleServe', core => core.policy.networkOff('tailscaleServe')),

  'group.create': groupsOff,
  'group.join': groupsOff,
  'group.invite': groupsOff,
  'group.ticket': groupsOff,

  'contacts.invite': contactsOff,
  'contacts.join': contactsOff,
  'contacts.grant': contactsOff,
  'contacts.sendHuman': contactsOff,
  'contacts.decide': when('network.contacts', (core, params) => params.accept === true && core.policy.networkOff('contacts')),
  'contacts.decideMail': when('network.contacts', (core, params) => params.accept === true && core.policy.networkOff('contacts')),
  'contacts.tailscaleKey': when('network.contacts', (core, params) => params.key !== null && core.policy.networkOff('contacts')),

  'threads.linkPullRequest': pullRequestsOff,
  'threads.watchPullRequest': pullRequestsOff,
};

/** The methods the gate holds a rule for, which the policy test walks. */
export const GATED_METHODS = Object.keys(RULES) as RpcMethodName[];

/** Throws the refusal naming the key when the policy forbids this call. */
export function policyGate(core: Core): (method: RpcMethodName, params: unknown) => void {
  return (method, params) => {
    const rule = RULES[method];
    if (rule === undefined || !core.policy.active) return;
    const blocked = rule(core, typeof params === 'object' && params !== null ? params as Params : {});
    if (blocked !== null) throw core.policy.refusal(blocked[0], blocked[1]);
  };
}

/** The door, the read clients draw their locked controls from, and what follows a change of the file. */
export function registerPolicy(core: Core): void {
  core.router.policy = policyGate(core);
  // A read looks at the file first: an administrator's edit shows without waiting for the poll.
  core.router.register('policy.get', () => { core.policy.reload(); return core.policy.state(); });
  core.policy.onChange((_state, before) => {
    core.settings.policyChanged(before.values);
    core.telemetry.policyChanged();
    // A provider the file allows or denies now is listed with its new state.
    core.bus.emit('providers.updated', core.providers.list());
  });
}
