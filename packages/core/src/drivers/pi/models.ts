import type { EffortLevel, ModelInfo, ProviderDescriptor } from '@boite/contracts';
import { messageOf, unavailable } from '../../errors.ts';
import { launchPrefix, profileFor, resolveExecutable } from '../../providers/loader.ts';
import type { ProbeContext } from '../types.ts';
import { agentEnv, textOf } from './mapping.ts';
import { AGENT_OWN_MODEL, PROBE_TIMEOUT_MS, STDERR_MAX, THINKING_LEVELS } from './protocol.ts';
import type { PiModel } from './protocol.ts';
import { dataOf, PiPeer } from './rpc.ts';

type Timer = ReturnType<typeof setTimeout>;

/** The words the picker shows for pi's level ids. */
const EFFORT_LABELS: Record<string, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

function effortLabel(id: string): string {
  return EFFORT_LABELS[id] ?? `${id.slice(0, 1).toUpperCase()}${id.slice(1)}`;
}

/**
 * The levels one model supports, exactly as pi decides them itself: the rule is
 * `getSupportedThinkingLevels` of `@earendil-works/pi-ai`
 * (`node_modules/@earendil-works/pi-ai/dist/models.js`). A model without
 * reasoning has `off` and nothing else, a level mapped to `null` is dropped, and
 * `xhigh` and `max` are only there when the model maps them.
 *
 * It is reproduced here rather than asked for because
 * `get_available_thinking_levels` answers for the model the session is on and
 * for no other, so reading the scale of five hundred models would mean five
 * hundred `set_model` round trips. The session's own answer is still read, as
 * the cross-check below.
 */
function supportedLevels(model: PiModel): string[] {
  if (model.reasoning !== true) return ['off'];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === 'xhigh' || level === 'max') return mapped !== undefined;
    return true;
  });
}

/**
 * A model's `ModelInfo.effort`. A scale of one level is no choice at all, which
 * is what a model without reasoning answers, so it carries no effort block.
 */
function effortOf(model: PiModel, wanted: string): ModelInfo['effort'] | null {
  const ids = supportedLevels(model);
  if (ids.length < 2) return null;
  const levels: EffortLevel[] = ids.map((id) => ({ id, label: effortLabel(id) }));
  return { levels, default: ids.includes(wanted) ? wanted : (ids[0] ?? '') };
}

/** pi's provider ids are lowercase; the picker shows them with a capital. */
function providerLabel(provider: string): string {
  return `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}`;
}

/** What one probe read from the agent, before any of it becomes a `ModelInfo`. */
interface PiListing {
  models: PiModel[];
  /** The model the session is on, as `<provider>/<id>`, or an empty string. */
  current: string;
  /** The thinking level the session is on, the default effort of every model. */
  thinkingLevel: string;
  /** `get_available_thinking_levels`: the scale of the current model, and of it alone. */
  sessionLevels: string[];
}

/**
 * A pi listing as a model list. The id is what `--model` takes, `<provider>/<id>`,
 * and the name carries the provider so two models called the same are told apart.
 * The descriptor's `default` stays first so the choice can always go back to
 * pi's own configuration, and it carries no effort of its own. An agent that
 * lists nothing, which is what an unauthenticated pi does, leaves the
 * descriptor's models standing.
 */
function modelsFrom(provider: ProviderDescriptor, listing: PiListing): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: false });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listing.models) {
    const id = entry.id ?? '';
    const providerId = entry.provider ?? '';
    if (id.length === 0 || providerId.length === 0) continue;
    const full = `${providerId}/${id}`;
    if (seen.has(full)) continue;
    seen.add(full);
    const effort = effortOf(entry, listing.thinkingLevel);
    models.push({
      id: full,
      name: `${providerLabel(providerId)} / ${entry.name ?? id}`,
      default: full === listing.current,
      ...(effort === null ? {} : { effort }),
    });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `pi --mode rpc --no-session`: `get_state` for the model and the
 * level the session is on, `get_available_models` for the list, and
 * `get_available_thinking_levels` for the current model's own scale, which is
 * what `supportedLevels` is checked against. `--no-session` because a probe must
 * leave no transcript anywhere. The child goes through the registry that traced
 * it on every path; nothing of this process is kept.
 */
export async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  if (executable === null) {
    throw unavailable(`no ${ctx.provider.id} executable on this machine`, { providerId: ctx.provider.id });
  }

  let lastStderr = '';
  const child = ctx.spawnChild(executable, [...launchPrefix(profile), ...(profile?.launch?.args ?? []), '--no-session'], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.accountEnv),
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
  const peer = new PiPeer(child, {
    // A probe runs no turn: pi has nothing to stream and nothing to ask.
    event: () => undefined,
    log: (level, message) => {
      ctx.log(level, message);
    },
  });

  try {
    const died = new Promise<never>((_resolve, reject) => {
      child.once('exit', (code) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent exited with code ${code ?? 'unknown'}`), detail));
      });
      child.once('error', (error) => {
        reject(unavailable(say(`the ${ctx.provider.id} agent did not start: ${messageOf(error)}`), detail));
      });
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          unavailable(
            say(`the ${ctx.provider.id} agent did not list its models in ${PROBE_TIMEOUT_MS / 1000} s`),
            detail,
          ),
        );
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });

    const read = (async (): Promise<PiListing> => {
      const state = dataOf(await peer.command('get_state'));
      const listed = dataOf(await peer.command('get_available_models'));
      const levels = dataOf(await peer.command('get_available_thinking_levels'));
      const current = (state['model'] ?? {}) as PiModel;
      const currentId =
        typeof current.id === 'string' && typeof current.provider === 'string'
          ? `${current.provider}/${current.id}`
          : '';
      return {
        models: Array.isArray(listed['models']) ? (listed['models'] as PiModel[]) : [],
        current: currentId,
        thinkingLevel: textOf(state['thinkingLevel']),
        sessionLevels: Array.isArray(levels['levels']) ? (levels['levels'] as string[]) : [],
      };
    })();

    const listing = await Promise.race([read, died, expired]);
    checkLevels(ctx, listing);
    return modelsFrom(ctx.provider, listing);
  } finally {
    if (timer !== null) clearTimeout(timer);
    peer.fail('the pi probe is over');
    try {
      child.stdin.end();
    } catch {
      // the pipe is already gone
    }
    ctx.killTree();
  }
}

/**
 * The one place pi answers a scale itself is the model the session is on, so
 * that answer is what says whether `supportedLevels` still matches pi's rule. A
 * mismatch means pi changed it: one warning naming both, never a silent list of
 * levels the agent would refuse.
 */
function checkLevels(ctx: ProbeContext, listing: PiListing): void {
  if (listing.sessionLevels.length === 0 || listing.current === '') return;
  const current = listing.models.find((model) => `${model.provider ?? ''}/${model.id ?? ''}` === listing.current);
  if (current === undefined) return;
  const computed = supportedLevels(current).join(',');
  const answered = listing.sessionLevels.join(',');
  if (computed === answered) return;
  ctx.log(
    'warn',
    `pi probe: the levels of ${listing.current} read as ${computed} but the agent answered ${answered}`,
  );
}
