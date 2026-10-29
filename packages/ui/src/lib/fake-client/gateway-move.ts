/** Moving this machine's logins into Douane, as the core does it, against no real gateway. */
import { isLoopbackHost, RpcErrorCode, subscriptionProxyOrigin, type GatewayMoveItem, type GatewayMoveOutcome, type SubscriptionProxy } from '@boite/contracts';
import { RpcFailure } from '../client';
import { gatewayBlockOf } from '../policy';
import type { FakeContext } from './context';
import { policyRefusal } from './policy';

const LOGINS = new Set(['claude', 'codex', 'grok']);

interface MoveState { token: boolean; moved: Set<string> }
const states = new WeakMap<FakeContext, MoveState>();
function stateOf(ctx: FakeContext): MoveState {
  let state = states.get(ctx);
  if (!state) states.set(ctx, state = { token: false, moved: new Set() });
  return state;
}

function douane(ctx: FakeContext, target?: string) {
  let proxy: SubscriptionProxy | null;
  if (target === 'plugin') {
    const port = ctx.plugins.gatewayPort('douane');
    proxy = ctx.plugins.gatewayRunning('douane') ? { enabled: false, kind: 'douane', baseUrl: `http://127.0.0.1:${port}/v1`, dashboardUrl: `http://127.0.0.1:${port}/admin/` } : null;
  } else {
    const saved = ctx.settings.subscriptionProxy;
    proxy = saved && saved.kind === 'douane' && saved.baseUrl ? saved : null;
  }
  const blocked = ctx.policy.present ? gatewayBlockOf(ctx.policy.values, proxy?.baseUrl ?? null) : null;
  if (blocked !== null) throw policyRefusal(ctx, blocked, proxy?.baseUrl);
  return proxy;
}

function items(ctx: FakeContext): GatewayMoveItem[] {
  const list: GatewayMoveItem[] = [];
  for (const account of ctx.accounts) {
    const common = { accountId: account.id, providerId: account.providerId };
    if (LOGINS.has(account.providerId)) {
      const signedIn = account.status !== 'unauthenticated';
      list.push({ ...common, id: `${account.id}:login`, kind: 'login', movable: signedIn, reason: signedIn ? null : 'signedOut' });
    } else if (account.providerId === 'opencode') {
      list.push(
        { ...common, id: `${account.id}:copilot`, kind: 'copilot', source: { id: 'github-copilot', name: 'GitHub Copilot' }, movable: true, reason: null },
        { ...common, id: `${account.id}:key:deepseek`, kind: 'endpoint', source: { id: 'deepseek', name: 'DeepSeek' }, route: 'deepseek', baseUrl: 'https://api.deepseek.com', movable: true, reason: null },
        { ...common, id: `${account.id}:key:opencode`, kind: 'endpoint', source: { id: 'opencode', name: 'OpenCode Zen' }, route: 'zen', baseUrl: 'https://opencode.ai/zen/v1', movable: true, reason: null },
        { ...common, id: `${account.id}:key:groq`, kind: 'endpoint', source: { id: 'groq', name: 'Groq' }, route: 'groq', movable: false, reason: 'noAddress' },
      );
    }
  }
  return list;
}

export function gatewayMoveMethods(ctx: FakeContext) {
  return {
    'subscriptionProxy.movePlan': async ({ target }: { target?: string } = {}) => {
      const proxy = douane(ctx, target);
      return { origin: proxy ? subscriptionProxyOrigin(proxy) : null, managementToken: stateOf(ctx).token, items: items(ctx) };
    },
    'subscriptionProxy.move': async ({ ids, managementToken, target }: { ids: string[]; managementToken?: string | null; target?: string }) => {
      if (!Array.isArray(ids) || ids.length === 0) throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'ids must be 1 to 200 item ids from subscriptionProxy.movePlan', data: { field: 'ids' } });
      const proxy = douane(ctx, target);
      if (!proxy) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'configure a Douane gateway first: moving logins needs Douane', data: { field: 'subscriptionProxy.kind' } });
      const state = stateOf(ctx);
      if (managementToken !== undefined) state.token = managementToken !== null;
      // A remote Douane wants its management token, as one with `management_token_env` does.
      const origin = subscriptionProxyOrigin(proxy);
      if (!state.token && !isLoopbackHost(new URL(origin).hostname)) {
        throw new RpcFailure({ code: RpcErrorCode.Refused, message: `Douane at ${origin} refused the management request (HTTP 401): enter its management token`, data: { field: 'managementToken' } });
      }
      const known = new Map(items(ctx).map(item => [item.id, item]));
      const outcomes: GatewayMoveOutcome[] = [...new Set(ids)].map((id) => {
        const item = known.get(id);
        if (!item) return { id, outcome: 'missing', reason: null, message: null };
        if (!item.movable) return { id, outcome: 'refused', reason: item.reason, message: null };
        if (item.route === 'zen') return { id, outcome: 'refused', reason: null, message: 'upstream answered HTTP 401' };
        if (state.moved.has(id)) return { id, outcome: 'present', reason: null, message: null };
        state.moved.add(id);
        return { id, outcome: 'moved', reason: null, message: null };
      });
      return { outcomes };
    },
  };
}
