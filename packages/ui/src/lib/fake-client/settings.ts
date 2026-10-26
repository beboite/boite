/** Core settings, the scheduler they size, keybindings and telemetry. */
import { KEYBINDING_COMMANDS, MACHINE_SETTINGS, parseChord, RpcErrorCode, checkSettingsPatch, followedPatch, keepLaterFavorites } from '@boite/contracts';
import type { Settings } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';
import { gatewayQuotas } from './accounts';
import { fakeCore } from './coordination';
import { settleMachineSetting, settleSettings } from './requests';

export function settingsMethods(ctx: FakeContext) {
  const methods = {
    'subscriptionProxy.key': async ({ key }) => {
      if (key !== null && (typeof key !== 'string' || key.length > 4096 || !key.trim() || /[\u0000-\u0020\u007f]/.test(key))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'subscriptionProxy.key must be null or a non-empty token without whitespace' });
      return { configured: key !== null };
    },
    'subscriptionProxy.configure': async ({ subscriptionProxy, key }) => {
      if (!subscriptionProxy || typeof subscriptionProxy !== 'object') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'subscriptionProxy configuration is required' });
      if (key !== undefined && key !== null && (typeof key !== 'string' || key.length > 4096 || !key.trim() || /[\u0000-\u0020\u007f]/.test(key))) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'subscriptionProxy.key must be null or a non-empty token without whitespace' });
      const checked = checkSettingsPatch({ subscriptionProxy });
      if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: checked.message, data: { field: checked.field } });
      // As the core: local mode stores the Douane plugin's loopback URLs, whatever was sent.
      const proxy = checked.patch.subscriptionProxy;
      if (proxy?.mode === 'local') {
        const port = ctx.plugins.gatewayPort('douane');
        checked.patch.subscriptionProxy = { ...proxy, kind: 'douane', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` };
      }
      ctx.settings = { ...ctx.settings, ...checked.patch };
      ctx.emit('settings.updated', { ...ctx.settings });
      // As the core: another gateway starts its quotas over.
      ctx.emit('subscriptionProxy.quotasUpdated', gatewayQuotas(ctx));
      return { ...ctx.settings };
    },
    'subscriptionProxy.setEnabled': async ({ enabled }) => {
      if (typeof enabled !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'subscriptionProxy.setEnabled enabled must be a boolean', data: { field: 'enabled' } });
      const proxy = ctx.settings.subscriptionProxy;
      if (!proxy?.baseUrl) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'no subscription proxy is configured: the owner sets one up in Settings > Accounts', data: { field: 'subscriptionProxy' } });
      if (proxy.enabled === enabled) return { ...ctx.settings };
      ctx.settings = { ...ctx.settings, subscriptionProxy: { ...proxy, enabled } };
      ctx.emit('settings.updated', { ...ctx.settings });
      ctx.emit('subscriptionProxy.quotasUpdated', gatewayQuotas(ctx));
      return { ...ctx.settings };
    },
    'scheduler.get': async (params) => {
      return structuredClone(ctx.scheduler);
    },
    'telemetry.state': async () => ({ ...ctx.telemetry }),
    'telemetry.configure': async ({ mode, countChoice }) => {
      if (!['off', 'basic', 'enhanced'].includes(mode)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'mode: expected off, basic or enhanced' });
      if (countChoice !== undefined && typeof countChoice !== 'boolean') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'countChoice: expected a boolean' });
      if (ctx.telemetry.mode === 'enhanced' && mode !== 'enhanced') ctx.telemetry.pendingDeletion = true;
      ctx.telemetry.mode = mode;
      return { ...ctx.telemetry };
    },
    'telemetry.retryForget': async () => {
      ctx.telemetry.pendingDeletion = false;
      return { ...ctx.telemetry };
    },
    'telemetry.export': async () => {
      if (ctx.telemetry.mode !== 'enhanced') throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'telemetry export: expected enhanced mode' });
      return { events: [], truncated: false };
    },
    'settings.get': async (params) => {
      return { ...ctx.settings };
    },
    'keybindings.get': async (params) => {
      return structuredClone(ctx.keybindings);
    },
    'keybindings.set': async (params) => {
      const { command, chord } = params;
      if (!(KEYBINDING_COMMANDS as readonly string[]).includes(command)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `command: "${command}" is not a command Boite has` });
      }
      if (chord !== null) {
        const parsed = parseChord(chord);
        if (!parsed.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `chord: ${parsed.reason}` });
      }
      ctx.keybindings = { ...ctx.keybindings, bindings: { ...ctx.keybindings.bindings, [command]: chord === null ? null : chord.trim().toLowerCase() } };
      ctx.emit('keybindings.updated', structuredClone(ctx.keybindings));
      return structuredClone(ctx.keybindings);
    },
    'keybindings.reset': async (params) => {
      const { command } = params;
      const bindings = { ...ctx.keybindings.bindings };
      if (command === undefined) for (const id of KEYBINDING_COMMANDS) delete bindings[id];
      else delete bindings[command];
      ctx.keybindings = { ...ctx.keybindings, bindings };
      ctx.emit('keybindings.updated', structuredClone(ctx.keybindings));
      return structuredClone(ctx.keybindings);
    },
    'settings.follow': async (params: { patch: unknown }): Promise<Settings> => {
      const patch: unknown = params?.patch;
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'patch: expected an object of settings', data: { field: 'patch' } });
      const followed = followedPatch(ctx.settings, patch);
      return Object.keys(followed).length === 0 ? structuredClone(ctx.settings) : methods['settings.set']({ ...followed });
    },
    'settings.set': async (params) => {
      // The core's own check, so a value the core refuses is refused here too.
      const checked = checkSettingsPatch(params);
      if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: checked.message, data: { field: checked.field } });
      const titleModel = checked.patch.titleModel;
      if (titleModel && ctx.providers.find(p => p.id === titleModel.providerId)?.titles !== true) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `titleModel names ${titleModel.providerId}, which is not a loaded provider that writes titles`, data: { field: 'titleModel' } });
      }
      const tracker = checked.patch.goalTracker;
      if (tracker && !ctx.providers.some(p => p.id === tracker.providerId)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: `goalTracker names ${tracker.providerId}, which is not a loaded provider`, data: { field: 'goalTracker' } });
      }
      const before = Object.fromEntries(MACHINE_SETTINGS.map(key => [key, ctx.settings[key] === true]));
      ctx.settings = { ...ctx.settings, ...keepLaterFavorites(ctx.settings, checked.patch) };
      // As the core's `setting.changed`: the other members' cards about this machine settle.
      for (const key of MACHINE_SETTINGS) {
        if ((ctx.settings[key] === true) === before[key]) continue;
        for (const core of ctx.roster?.cores ?? []) {
          const other = core.coreId === ctx.identity.coreId ? undefined : fakeCore(core.coreId);
          if (other) settleMachineSetting(other, ctx.identity.coreId, key, ctx.settings[key] === true);
        }
      }
      ctx.emit('scheduler.updated', structuredClone(ctx.scheduler));
      ctx.emit('settings.updated', { ...ctx.settings });
      settleSettings(ctx, ctx.settings);
      if (checked.patch.subscriptionProxy) ctx.emit('subscriptionProxy.quotasUpdated', gatewayQuotas(ctx));
      return { ...ctx.settings };
    },
  } satisfies Partial<FakeMethods>;
  return methods;
}
