import type { Core } from './core.ts';
import { registerAccountMethods } from './accounts.ts';
import { registerProjectMethods } from './projects.ts';
import { registerProviderMethods } from './providers/loader.ts';
import { registerProbeMethods } from './providers/probe.ts';
import { registerSchedulerMethods } from './scheduler.ts';
import { registerSettingsMethods } from './settings.ts';
import { registerThreadMethods } from './threads.ts';
import { registerTraceMethods } from './trace.ts';
import { registerUsageMethods } from './usage.ts';

/** Adding a module is one file plus one line here. `hello` is the server's own. */
export function registerModules(core: Core): void {
  registerProjectMethods(core);
  registerProviderMethods(core);
  registerProbeMethods(core);
  registerAccountMethods(core);
  registerThreadMethods(core);
  registerSchedulerMethods(core);
  registerTraceMethods(core);
  registerUsageMethods(core);
  registerSettingsMethods(core);
}
