import type { Core } from './core.ts';
import { registerAccountMethods } from './accounts.ts';
import { registerProjectMethods } from './projects.ts';
import { registerProviderMethods } from './providers/loader.ts';
import { registerProbeMethods } from './providers/probe.ts';
import { registerSchedulerMethods } from './scheduler.ts';
import { registerSessionMethods } from './sessions.ts';
import { registerSettingsMethods } from './settings.ts';
import { registerThreadMethods } from './threads.ts';
import { registerTraceMethods } from './trace.ts';
import { registerUsageMethods } from './usage.ts';

/** Adding a module is one file plus one line here. `hello` is the server's own. */
export function registerModules(core: Core): void {
  core.router.register('quotas.list', (params) => core.quotas.list(params.refresh));
  core.router.register('quotas.configure', (params) => core.quotas.configure(params.accountId, params.enabled));
  core.router.register('plugins.list', () => [core.plugins.state()]);
  core.router.register('plugins.install', (params) => core.plugins.install(params.id));
  core.router.register('plugins.cancel', (params) => core.plugins.cancel(params.id));
  core.router.register('plugins.uninstall', (params) => core.plugins.uninstall(params.id));
  core.router.register('plugins.accounts', (params) => core.plugins.accounts(params.id, params.refresh));
  core.router.register('plugins.accountAction', (params) => core.plugins.accountAction(params));
  registerProjectMethods(core);
  registerProviderMethods(core);
  registerProbeMethods(core);
  registerAccountMethods(core);
  registerThreadMethods(core);
  registerSchedulerMethods(core);
  registerTraceMethods(core);
  registerUsageMethods(core);
  registerSettingsMethods(core);
  registerSessionMethods(core);
}
