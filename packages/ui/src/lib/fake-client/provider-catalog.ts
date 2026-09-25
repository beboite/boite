/** The provider list, its reload and dry run, and the model catalog a probe reads. */
import { RpcErrorCode, type Account, type ModelInfo, type RpcResult } from '@boite/contracts';
import { RpcFailure } from '../client';
import { MUSE_EFFORT, PROBE_MS, PROBED_MODELS, UPDATABLE_ID } from './providers';
import { DATA_DIR } from './shared';
import type { FakeContext, FakeMethods } from './context';

/**
 * The core's `modelsFor`: the descriptor's list, after what the last probe of
 * this account read, and a model both list only once.
 */
export function modelsOf(ctx: FakeContext, providerId: string, accountId: string): ModelInfo[] {
  const described = ctx.providers.find(p => p.id === providerId)?.models ?? [];
  const probed = ctx.modelCatalogs.get(providerId + '::' + accountId);
  if (probed === undefined) return described;
  const known = new Set(probed.map((model) => model.id));
  return [...probed, ...described.filter((model) => !known.has(model.id))];
}

export function checkSpeed(ctx: FakeContext, providerId: string, accountId: string, model: string | null, speed: string | null): void {
  if (speed === null) return;
  const models = modelsOf(ctx, providerId, accountId);
  if (!models.find(m => m.id === model)?.speeds?.some(option => option.id === speed)) throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the model does not offer this speed' });
}

/**
 * ACP, Codex and pi probe their own catalogs. Demo models are explicitly
 * named as such; only OpenCode uses the large catalog fixture.
 */
async function probe(ctx: FakeContext, providerId: string, accountId: string): Promise<RpcResult<'providers.probe'>> {
  const provider = ctx.providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new RpcFailure({ code: RpcErrorCode.NotFound, message: `unknown provider ${providerId}` });
  }
  const account = ctx.accounts.find((a) => a.id === accountId);
  if (!account) throw ctx.notFound('account', accountId);
  if (account.providerId !== providerId) {
    throw new RpcFailure({ code: RpcErrorCode.Refused, message: 'the account belongs to another provider' });
  }
  const dynamic = ['acp', 'codex-appserver', 'muse', 'pi', 'agy'].includes(provider.protocol);
  if (dynamic && !provider.available) {
    throw new RpcFailure({ code: RpcErrorCode.Unavailable, message: `${provider.name} is not available on this machine` });
  }
  let models = structuredClone(provider.models);
  if (dynamic) {
    models = provider.id === UPDATABLE_ID ? structuredClone(PROBED_MODELS) : [
      ...models,
      { id: `${provider.id}-demo`, name: `${provider.name} demo model`, default: false, ...(provider.protocol === 'codex-appserver' ? { effort: { levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }], default: 'high' }, speeds: [{ id: 'fast', label: 'Fast' }, { id: 'ultrafast', label: 'Ultrafast' }] } : provider.protocol === 'muse' ? { effort: MUSE_EFFORT } : {}) }
    ];
    await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
  }
  ctx.modelCatalogs.set(providerId + '::' + accountId, models);
  const probedAt = ctx.now();
  ctx.emit('providers.probed', { providerId, accountId, models: structuredClone(models), probedAt });
  return { models, probedAt };
}

export function providerCatalogMethods(ctx: FakeContext) {
  return {
    'providers.list': async (params) => {
      return { loaded: structuredClone(ctx.providers), rejected: [] };
    },
    'providers.reload': async (params) => {
      // As the core: a reload that changes no provider tells nobody, so a page
      // that reloads on focus keeps every model list it already read.
      const before = JSON.stringify(ctx.providers);
      for (const provider of ctx.providers) {
        if (!provider.available || ctx.accounts.some(account => account.providerId === provider.id)) continue;
        const id = `a-${++ctx.seq}`;
        const account: Account = {
          id, providerId: provider.id, label: 'Default',
          isolationDir: provider.alwaysIsolated ? `${DATA_DIR}/accounts/${id}` : null,
          status: provider.alwaysIsolated ? 'unauthenticated' : 'ok', identity: null, createdAt: ctx.now(),
        };
        ctx.accounts.push(account);
        ctx.emit('accounts.updated', structuredClone(account));
      }
      const result = { loaded: structuredClone(ctx.providers), rejected: [] };
      if (JSON.stringify(ctx.providers) !== before) ctx.emit('providers.updated', structuredClone(result));
      return result;
    },
    'providers.probe': async (params) => {
      // The fixture catalogue already carries each model's own scale, so a probe
      // naming a model answers the same list; only the refusal is mirrored.
      if (params.model !== undefined && (typeof params.model !== 'string' || params.model.length === 0)) {
        throw new RpcFailure({ code: RpcErrorCode.InvalidParams, message: 'model must be a non-empty string when given', data: { field: 'model', expected: 'a non-empty string' } });
      }
      return probe(ctx, params.providerId, params.accountId);
    },
    'providers.dryRun': async (params) => {
      const provider = ctx.providers[0];
      if (!params.file.endsWith('.json') || !provider) {
        return {
          ok: false,
          rejected: {
            file: params.file,
            field: 'file',
            expected: 'a path ending in .json',
            message: 'not a descriptor file'
          }
        };
      }
      return {
        ok: true,
        summary: structuredClone(provider),
        plan: { roots: [DATA_DIR], env: ['BOITE_ISOLATION_DIR'], closes: [] }
      };
    },
  } satisfies Partial<FakeMethods>;
}
