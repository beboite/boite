import type { EffortLevel, ModelInfo, ProviderDescriptor } from '@boite/contracts';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { messageOf, unavailable } from '../../errors.ts';
import { agentEnv, profileFor } from '../../providers/resolve.ts';
import type { ProbeContext } from '../types.ts';
import { museExecutable, textOf } from './mapping.ts';
import type { MuseModelList, Timer } from './protocol.ts';
import {
  AGENT_OWN_MODEL,
  DEFAULT_EFFORT,
  EFFORTS,
  FALLBACK_EFFORTS,
  META_PROVIDER,
  PROBE_FLAGS,
  PROBE_TIMEOUT_MS,
  STDERR_MAX,
} from './protocol.ts';
import { handshake, MuseRpc } from './rpc.ts';

// ---------------------------------------------------------------------------
// The probe: the models the host lists
// ---------------------------------------------------------------------------

const EFFORT_LABELS: Record<string, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
};

/** `muse-spark-1.3` as `Muse Spark 1.3`, when the catalog repeats the id as its label. */
function modelName(id: string, label: string | undefined): string {
  const text = (label ?? '').trim();
  if (text.length > 0 && text !== id) return text;
  if (!/^muse(-[a-z0-9.]+)+$/.test(id)) return id;
  return id
    .split('-')
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/**
 * The effort tiers per model, read from the catalog Muse caches under its home
 * (`model-catalog/*.json`, rows with `reasoning_effort_variants`), because
 * `model/list` does not carry them. A cache in another shape is skipped.
 */
export function readCatalogEfforts(museHome: string, profileId: string | null): Map<string, EffortLevel[]> {
  const efforts = new Map<string, EffortLevel[]>();
  const dir = join(museHome, 'model-catalog');
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return efforts;
  }
  for (const file of files) {
    let catalog: { profile_id?: unknown; rows?: unknown };
    try {
      catalog = JSON.parse(readFileSync(join(dir, file), 'utf8')) as typeof catalog;
    } catch {
      continue;
    }
    if ((catalog.profile_id ?? null) !== profileId || !Array.isArray(catalog.rows)) continue;
    for (const raw of catalog.rows) {
      const row = (raw ?? {}) as Record<string, unknown>;
      const variants = row['reasoning_effort_variants'];
      if (row['provider_id'] !== META_PROVIDER || row['visibility'] !== 'visible' || !Array.isArray(variants)) continue;
      const levels: EffortLevel[] = [];
      for (const variant of variants) {
        const tier = textOf((variant as Record<string, unknown>)?.['tier']);
        if (!(EFFORTS as readonly string[]).includes(tier) || levels.some((level) => level.id === tier)) continue;
        const description = textOf((variant as Record<string, unknown>)['description']);
        levels.push({ id: tier, label: EFFORT_LABELS[tier] ?? tier, ...(description.length > 0 ? { description } : {}) });
      }
      if (levels.length > 0 && typeof row['model_id'] === 'string') efforts.set(row['model_id'], levels);
    }
  }
  return efforts;
}

function effortBlock(levels: EffortLevel[]): ModelInfo['effort'] {
  const ids = levels.map((level) => level.id);
  const fallback = ids.includes(DEFAULT_EFFORT) ? DEFAULT_EFFORT : ids.includes('medium') ? 'medium' : (ids[0] ?? '');
  return { levels, default: fallback };
}

/**
 * A `model/list` answer as a model list, the descriptor's `default` first so
 * the choice can always go back to Muse's own. A host that lists nothing, which
 * is what one that is not signed in does, leaves the descriptor's models
 * standing.
 */
export function modelsFrom(provider: ProviderDescriptor, list: MuseModelList, efforts: Map<string, EffortLevel[]>): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  const fallback = FALLBACK_EFFORTS.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id }));
  for (const entry of list.models ?? []) {
    const id = entry.modelId;
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    if (entry.providerId !== undefined && entry.providerId !== META_PROVIDER) continue;
    seen.add(id);
    models.push({
      id,
      name: modelName(id, entry.displayLabel),
      default: entry.isDefault === true,
      effort: effortBlock(efforts.get(id) ?? fallback),
    });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `muse serve` that can neither write nor run a shell and keeps
 * no session log: `initialize`, `initialized`, `model/list`. The child goes
 * through the registry that traced it on every path.
 */
export async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const executable = museExecutable(ctx.provider);
  let lastStderr = '';
  const child = ctx.spawnChild(executable, [...(profileFor(ctx.provider)?.launch?.args ?? []), ...PROBE_FLAGS], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    for (const line of chunk.split(/\r?\n/)) {
      const text = line.trim();
      if (text.length > 0) lastStderr = text.slice(0, STDERR_MAX);
    }
  });

  const say = (head: string): string => (lastStderr.length === 0 ? head : `${head}: ${lastStderr}`);
  const detail = { providerId: ctx.provider.id, accountId: ctx.accountId };
  let timer: Timer | null = null;
  const rpc = new MuseRpc(child, {
    notification: () => undefined,
    log: (level, message) => {
      ctx.log(level, message);
    },
  });

  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} host exited with code ${code ?? 'unknown'}`), detail));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} host did not start: ${messageOf(error)}`), detail));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(say(`the ${ctx.provider.id} host did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`), detail));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const read = (async (): Promise<ModelInfo[]> => {
      const init = await handshake(rpc);
      const list = await rpc.request<MuseModelList>('model/list', {});
      const efforts =
        typeof init.museHome === 'string' && list.source === 'providerCatalog'
          ? readCatalogEfforts(init.museHome, list.profileId ?? null)
          : new Map<string, EffortLevel[]>();
      return modelsFrom(ctx.provider, list, efforts);
    })();

    return await Promise.race([read, died, expired]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    rpc.fail('the muse probe is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}
