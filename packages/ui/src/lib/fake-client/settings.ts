/** Core settings, the scheduler they size, keybindings and telemetry. */
import { KEYBINDING_COMMANDS, parseChord, RpcErrorCode, checkSettingsPatch } from '@boite/contracts';
import { RpcFailure } from '../client';
import type { FakeContext, FakeMethods } from './context';

export function settingsMethods(ctx: FakeContext) {
  return {
    'scheduler.get': async (params) => {
      return structuredClone(ctx.scheduler);
    },
    'telemetry.state': async () => ({ ...ctx.telemetry }),
    'telemetry.configure': async ({ mode }) => {
      if (!['off', 'basic', 'enhanced'].includes(mode)) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'mode: expected off, basic or enhanced' });
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
    'settings.set': async (params) => {
      // The core's own check, so a value the core refuses is refused here too.
      const checked = checkSettingsPatch(params);
      if (!checked.ok) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: checked.message, data: { field: checked.field } });
      ctx.settings = { ...ctx.settings, ...checked.patch };
      ctx.scheduler = {
        ...ctx.scheduler,
        maxConcurrentTurns: ctx.settings.maxConcurrentTurns,
        perAccountConcurrency: ctx.settings.perAccountConcurrency
      };
      ctx.emit('scheduler.updated', structuredClone(ctx.scheduler));
      ctx.emit('settings.updated', { ...ctx.settings });
      return { ...ctx.settings };
    },
  } satisfies Partial<FakeMethods>;
}
