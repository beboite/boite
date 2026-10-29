import type { RpcMethodName, RpcMethods } from './index.ts';
import { checkSettingsPatch } from './settings-validation.ts';

export type RpcParamsCheck<T = unknown> =
  | { ok: true; params: T }
  | { ok: false; field: string; message: string };

/**
 * The runtime rules of a method's params, one per method, read by the core's
 * router and the in-memory client alike. A method listed here reaches its
 * handler only with params its rule accepted, in the form the rule returned;
 * a method not listed yet checks its own params in its handler.
 */
const RPC_PARAMS: { readonly [M in RpcMethodName]?: (params: unknown) => RpcParamsCheck<RpcMethods[M]['params']> } = {
  'settings.set': params => {
    const checked = checkSettingsPatch(params);
    return checked.ok ? { ok: true, params: checked.patch } : checked;
  },
};

/** The params a handler receives, or the field the method's rule refuses. */
export function checkRpcParams(method: string, params: unknown): RpcParamsCheck {
  const rule = Object.hasOwn(RPC_PARAMS, method) ? RPC_PARAMS[method as RpcMethodName] : undefined;
  return rule ? rule(params) : { ok: true, params };
}
