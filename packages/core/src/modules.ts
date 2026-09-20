import type { Core } from './core.ts';
import { registerAccountMethods } from './accounts.ts';
import { registerAgentMethods } from './agent.ts';
import { registerImportMethods } from './imports.ts';
import { registerKeybindingMethods } from './keybindings.ts';
import { registerProjectMethods } from './projects.ts';
import { registerProviderMethods } from './providers/loader.ts';
import { registerProbeMethods } from './providers/probe.ts';
import { registerUpdateMethods } from './providers/updates.ts';
import { registerSchedulerMethods } from './scheduler.ts';
import { registerSessionMethods } from './sessions.ts';
import { registerSettingsMethods } from './settings.ts';
import { registerThreadMethods } from './threads.ts';
import { registerTraceMethods } from './trace.ts';
import { registerUsageMethods } from './usage.ts';
import { registerPushMethods } from './push.ts';
import { registerSpeechMethods } from './speech.ts';

/** Adding a module is one file plus one line here. `hello` is the server's own. */
export function registerModules(core: Core): void {
  registerSpeechMethods(core);
  registerPushMethods(core);
  core.router.register('threads.activity.set', (params) => core.activity.set(params));
  core.router.register('threads.activity.control', (params) => core.activity.control(params));
  core.router.register('quotas.list', (params) => core.quotas.list(params.refresh));
  core.router.register('quotas.configure', (params) => core.quotas.configure(params.accountId, params.enabled));
  core.router.register('plugins.list', () => core.plugins.list());
  core.router.register('plugins.inspect', (params) => core.plugins.inspect(params));
  core.router.register('plugins.add', (params) => core.plugins.add(params.previewId));
  core.router.register('plugins.install', (params) => core.plugins.install(params.id));
  core.router.register('plugins.cancel', (params) => core.plugins.cancel(params.id));
  core.router.register('plugins.uninstall', (params) => core.plugins.uninstall(params.id));
  core.router.register('plugins.accounts', (params) => core.plugins.accounts(params.id, params.refresh));
  core.router.register('plugins.accountAction', (params) => core.plugins.accountAction(params));
  registerProjectMethods(core);
  registerProviderMethods(core);
  registerProbeMethods(core);
  registerUpdateMethods(core);
  registerAccountMethods(core);
  registerThreadMethods(core);
  registerSchedulerMethods(core);
  registerTraceMethods(core);
  registerUsageMethods(core);
  registerSettingsMethods(core);
  registerKeybindingMethods(core);
  registerSessionMethods(core);
  registerImportMethods(core);
  // The agent's own door, and the thread surfaces a client shares with it.
  registerAgentMethods(core);
}
