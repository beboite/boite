import { registerJournalInspection } from './journal/integrity.ts';
import type { Core } from './core.ts';
import { requireAgent } from './threads/agentless.ts';
import { registerPersistentAgents } from './agents/store.ts';
import { createAgent } from './agents/create.ts';
import { registerAccountMethods } from './accounts.ts';
import { registerHookMethods } from './hooks.ts';
import { registerSecretMethods } from './secrets/rpc.ts';
import { registerAgentMethods } from './agent.ts';
import { registerImportMethods } from './imports.ts';
import { registerKeybindingMethods } from './keybindings.ts';
import { registerProjectMethods } from './projects.ts';
import { registerProviderMethods } from './providers/loader.ts';
import { registerProbeMethods } from './providers/probe.ts';
import { registerUpdateMethods } from './providers/updates.ts';
import { registerSchedulerMethods } from './scheduler.ts';
import { registerSessionMethods } from './sessions.ts';
import { registerTailscaleMethods } from './tailscale.ts';
import { registerFirewallMethods } from './firewall.ts';
import { registerSettingsMethods } from './settings.ts';
import { registerPolicy } from './policy-gate.ts';
import { registerSubscriptionProxy } from './subscription-proxy.ts';
import { registerGatewayMove } from './gateway-move.ts';
import { registerThreadMethods } from './threads/rpc.ts';
import { registerTraceMethods } from './trace.ts';
import { registerUsageMethods } from './usage.ts';
import { registerPushMethods } from './push.ts';
import { registerSpeechMethods } from './speech.ts';
import { registerTelemetry } from './telemetry.ts';
import { registerCoordination } from './coordination.ts';
import { registerContactMethods } from './contacts/rpc.ts';
import { registerSharedComputeMethods } from './contacts/compute.ts';
import { registerResidentMethods } from './agents/projects.ts';
import { registerGroupMethods } from './group/rpc.ts';
import { registerTeams } from './teams/rpc.ts';
import { registerTerminalMethods } from './terminals.ts';
import { registerWorkflowMethods } from './workflows.ts';
import { registerWorktreeMethods } from './worktree-sweep.ts';
import { reveal } from './reveal.ts';
import { updateEverything } from './update-everything.ts';

/** Adding a module is one file plus one line here. `hello` is the server's own. */
export function registerModules(core: Core): void {
  registerPolicy(core);
  registerSharedComputeMethods(core);
  registerJournalInspection(core);
  core.router.register('core.logs', async params => {
    const records = await core.logs.query(params);
    if ((params as { anonymize?: unknown } | null)?.anonymize !== true) return records;
    const anonymizer = core.diagnostics.anonymizer();
    return records.map(record => anonymizer.record(record));
  });
  core.router.register('diagnostics.logs', (params, ctx) => core.diagnostics.logs(params, ctx.connection));
  core.router.register('diagnostics.summary', (params, ctx) => core.diagnostics.summary(params ?? {}, ctx.connection));
  core.router.register('diagnostics.export', (params, ctx) => core.diagnostics.export(params, ctx.connection));
  core.router.register('diagnostics.issue', (params, ctx) => core.diagnostics.issue(params, ctx.connection));
  core.router.register('diagnostics.report', (params, ctx) => core.diagnostics.report(params, ctx.connection));
  core.router.register('core.updateStatus', params => core.serverUpdates.status(params.refresh));
  core.router.register('core.updateInstall', params => core.serverUpdates.install(params.version));
  core.router.register('core.updateCancel', () => core.serverUpdates.cancel());
  core.router.register('core.updateEverything', params => updateEverything(core, params));
  core.router.register('core.desktopUpdateReport', (params, ctx) => core.desktopUpdates.report(params, ctx.connection));
  core.router.register('core.desktopUpdateStatus', () => core.desktopUpdates.snapshot());
  registerPersistentAgents(core);
  core.router.register('brain.status', () => core.brain.status());
  core.router.register('brain.commands', () => core.brain.commands());
  core.router.register('brain.configure', params => core.brain.configure(params));
  core.router.register('brain.sync', () => core.brain.sync());
  registerHookMethods(core);
  registerSecretMethods(core);
  registerTelemetry(core);
  registerCoordination(core);
  registerContactMethods(core);
  registerResidentMethods(core);
  registerGroupMethods(core);
  registerTeams(core);
  registerSpeechMethods(core);
  registerPushMethods(core);
  // A goal starts turns: a team chat runs none (`threads/agentless.ts`).
  core.router.register('threads.activity.set', (params) => { requireAgent(core.threads, params.threadId); return core.activity.set(params); });
  core.router.register('threads.activity.control', (params) => core.activity.control(params));
  core.router.register('threads.goal.track', (params) => { requireAgent(core.threads, params.threadId); return core.activity.track(params.threadId); });
  // Progress is for the window that asked: every other client would drop it on its requestId.
  core.router.register('quotas.list', (params, ctx) => core.quotas.list(params.refresh, params.requestId,
    (quota) => ctx.connection.sendEvent('quotas.progress', { requestId: params.requestId!, quota })));
  core.router.register('quotas.configure', (params) => core.quotas.configure(params.accountId, params.enabled));
  core.router.register('quotas.alert', (params) => core.quotas.alert(params.accountId, params.period, params.thresholds));
  core.router.register('quotas.reset', (params) => core.quotas.resets.reset(params.accountId, params.confirmed));
  core.router.register('plugins.list', () => core.plugins.list());
  core.router.register('plugins.inspect', (params) => core.plugins.inspect(params));
  core.router.register('plugins.add', (params) => core.plugins.add(params.previewId));
  core.router.register('plugins.install', (params) => core.plugins.install(params.id));
  core.router.register('plugins.cancel', (params) => core.plugins.cancel(params.id));
  core.router.register('plugins.uninstall', (params) => core.plugins.uninstall(params.id));
  core.router.register('plugins.accounts', (params) => core.plugins.accounts(params.id, params.refresh));
  core.router.register('plugins.accountAction', (params) => core.plugins.accountAction(params));
  core.router.register('plugins.app', (params) => core.plugins.app(params));
  core.router.register('plugins.autostart', (params) => core.plugins.autostart(params));
  core.router.register('plugins.gateway', (params) => core.plugins.gateway(params));
  core.router.register('plugins.checkUpdates', (params) => core.plugins.checkUpdates(params));
  core.router.register('ui.reveal', (params) => reveal(core, params));
  registerProjectMethods(core);
  registerProviderMethods(core);
  const probe = registerProbeMethods(core);
  core.activity.useProbe(probe);
  core.threads.spawns.useProbe(probe);
  core.delegation.remote.useProbe(probe);
  // A child on another machine of the group is read and steered there.
  core.router.register('delegation.result', params => (core.delegation.remote.child(params.threadId, params.agentId) ? core.delegation.remote.read(params) : core.delegation.resultPage(params)));
  core.router.register('delegation.wait', (params, ctx) => core.delegation.wait(params, ctx.connection));
  core.router.register('delegation.get', params => core.delegation.get(params.threadId));
  core.router.register('delegation.configure', params => core.delegation.configure(params.threadId, params.config));
  core.router.register('delegation.models', params => core.delegation.models(params.threadId, probe, params.machine));
  core.router.register('delegation.spawn', async params => {
    if (params.machine !== undefined) return core.delegation.remote.spawn(params);
    await core.delegation.prepareRoutes(params.threadId, probe, [typeof params.model === 'string' ? params.model : undefined]);
    return core.delegation.spawn(params);
  });
  // A bot's model resolves as a subagent's: read the lists a named model needs first.
  core.router.register('agents.create', async params => {
    await core.delegation.prepareRoutes(params.threadId, probe, [typeof params.model === 'string' ? params.model : undefined]);
    return createAgent(core, core.workforce, params);
  });
  core.router.register('delegation.send', (params, ctx) => {
    const origin = ctx.connection.identity.principal === 'agent' ? 'agent' : 'user';
    return core.delegation.remote.child(params.threadId, params.toThreadId) ? core.delegation.remote.send(params, origin) : core.delegation.send(params, origin);
  });
  // The agent's own stop leaves a pause it may lift; the owner's, one only the owner's next message releases.
  core.router.register('delegation.stop', (params, ctx) => ({ stopped: core.delegation.stop(params.threadId, params.agentId, ctx.connection.identity.principal === 'agent' ? 'agent' : 'stop') }));
  core.router.register('delegation.resume', (params, ctx) => core.delegation.resume(params.threadId, params.agentId, ctx.connection.identity.principal));
  registerWorkflowMethods(core, probe);
  registerUpdateMethods(core);
  registerAccountMethods(core);
  registerThreadMethods(core, probe);
  registerSchedulerMethods(core);
  registerTraceMethods(core);
  registerUsageMethods(core);
  registerSettingsMethods(core);
  registerSubscriptionProxy(core);
  registerGatewayMove(core);
  registerKeybindingMethods(core);
  registerSessionMethods(core);
  registerTailscaleMethods(core);
  registerFirewallMethods(core);
  registerImportMethods(core);
  registerTerminalMethods(core);
  registerWorktreeMethods(core);
  // The agent's own door, and the thread surfaces a client shares with it.
  registerAgentMethods(core);
}
