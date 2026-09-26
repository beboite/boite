/** The probe: what `agy models` lists, as the picker's models. */
import type { EffortLevel, ModelInfo, ProviderDescriptor } from '@boite/contracts';
import { messageOf, unavailable } from '../../errors.ts';
import { agentEnv, launchPrefix, profileFor, resolveExecutable } from '../../providers/resolve.ts';
import type { ProbeContext } from '../types.ts';
import { STDERR_MAX } from './events.ts';

/** How long `agy models` gets to answer. */
const PROBE_TIMEOUT_MS = 20_000;
/** What a probe keeps of the listing, far above any real one. */
const PROBE_OUTPUT_MAX = 1024 * 1024;
/** The model id that means "agy keeps the one it is configured with". */
export const AGENT_OWN_MODEL = 'default';
/** What `agy models` prints when nobody is signed in, on either stream. */
const SIGNED_OUT = /please sign in/i;

type Timer = ReturnType<typeof setTimeout>;

/** The reasoning variants agy spells as a suffix of the model id, in order. */
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
const VARIANT = new RegExp(`^(.+)-(${LEVELS.join('|')})$`);
/** `Gemini 3.8 Flash (Low)`: the model's name, then the variant's. */
const LABELLED = /^(.*\S)\s*\(([^()]+)\)$/;

/** One line of `agy models`: the id `--model` takes, a tab, the label. */
export interface AgyListed {
  id: string;
  label: string;
}

/**
 * `agy models` has no machine output this driver relies on: a progress line,
 * then `id<TAB>label` per model. Anything without a tab, or whose id is not one
 * word, is not a model line.
 */
export function parseModelLines(text: string): AgyListed[] {
  const listed: AgyListed[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const id = line.slice(0, tab).trim();
    if (!/^[A-Za-z0-9][\w.:/-]*$/.test(id)) continue;
    const label = line.slice(tab + 1).trim();
    listed.push({ id, label: label.length > 0 ? label : id });
  }
  return listed;
}

function capitalized(word: string): string {
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`;
}

/**
 * The listing as the picker's models. agy lists each reasoning variant as a
 * model of its own, `gemini-3.8-flash-low` beside `gemini-3.8-flash-high`; two
 * or more variants of one base become one model, `gemini-3.8-flash`, whose
 * effort scale is those variants, so the effort chip picks among them the way
 * it does for every other agent. The default level is `medium` when there is
 * one, else `high`, else the lowest. A variant alone, and every id without a
 * suffix such as `claude-opus-4-6-thinking`, stays as listed. The descriptor's
 * `default` stays first, meaning agy's own configured model; an empty listing
 * leaves the descriptor's models standing.
 */
export function modelsFromListing(provider: ProviderDescriptor, listed: AgyListed[]): ModelInfo[] {
  const groups = new Map<string, { name: string; levels: Map<string, string> }>();
  for (const entry of listed) {
    const match = VARIANT.exec(entry.id);
    if (match === null) continue;
    const base = match[1] ?? '';
    const level = match[2] ?? '';
    const label = LABELLED.exec(entry.label);
    const group = groups.get(base) ?? { name: label?.[1] ?? base, levels: new Map<string, string>() };
    if (!group.levels.has(level)) group.levels.set(level, label?.[2] ?? capitalized(level));
    groups.set(base, group);
  }

  const models: ModelInfo[] = [];
  const seen = new Set<string>();
  const own = provider.models.find((model) => model.id === AGENT_OWN_MODEL);
  if (own !== undefined) {
    models.push({ id: AGENT_OWN_MODEL, name: own.name, default: true });
    seen.add(AGENT_OWN_MODEL);
  }
  for (const entry of listed) {
    const match = VARIANT.exec(entry.id);
    const base = match?.[1] ?? '';
    const group = match === null ? undefined : groups.get(base);
    if (group !== undefined && group.levels.size >= 2) {
      if (seen.has(base)) continue;
      seen.add(base);
      const ids = LEVELS.filter((level) => group.levels.has(level));
      const levels: EffortLevel[] = ids.map((id) => ({ id, label: group.levels.get(id) ?? capitalized(id) }));
      const fallback = ids.includes('medium') ? 'medium' : ids.includes('high') ? 'high' : (ids[0] ?? '');
      models.push({ id: base, name: group.name, default: false, effort: { levels, default: fallback } });
      continue;
    }
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push({ id: entry.id, name: entry.label, default: false });
  }
  return models.length === (own === undefined ? 0 : 1) ? provider.models : models;
}

/**
 * One short-lived `agy models`, which prints its list and exits. It runs no
 * conversation and spends nothing. A signed-out agy says so instead of
 * listing, which is refused with the one thing to do about it.
 */
export async function readModels(ctx: ProbeContext): Promise<ModelInfo[]> {
  const profile = profileFor(ctx.provider);
  const executable = profile === undefined ? null : resolveExecutable(profile);
  const detail = { providerId: ctx.provider.id, accountId: ctx.accountId };
  if (executable === null) throw unavailable(`no ${ctx.provider.id} executable on this machine`, detail);

  const child = ctx.spawnChild(executable, [...launchPrefix(profile), ...(profile?.launch?.args ?? []), 'models'], {
    cwd: ctx.cwd,
    env: agentEnv(ctx.provider, ctx.accountEnv),
  });
  let stdout = '';
  let stderr = '';
  const keep = (sofar: string, chunk: string): string => (sofar.length >= PROBE_OUTPUT_MAX ? sofar : sofar + chunk);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout = keep(stdout, chunk);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr = keep(stderr, chunk);
  });
  child.stdin.on('error', () => undefined);
  try {
    child.stdin.end();
  } catch {
    // the pipe is already gone
  }

  let timer: Timer | null = null;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(unavailable(`agy models did not answer in ${PROBE_TIMEOUT_MS / 1000} s`, detail));
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
      child.once('close', (exit) => {
        resolve(exit);
      });
      child.once('error', (error) => {
        reject(unavailable(`the Antigravity CLI did not start: ${messageOf(error)}`, detail));
      });
    });
    if (SIGNED_OUT.test(stdout) || SIGNED_OUT.test(stderr)) {
      throw unavailable('the Antigravity CLI is not signed in: run agy in a terminal, sign in, then refresh', detail);
    }
    if (code !== 0) {
      const last = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? '';
      const head = `agy models exited with code ${code ?? 'unknown'}`;
      throw unavailable(last.length === 0 ? head : `${head}: ${last.slice(0, STDERR_MAX)}`, detail);
    }
    return modelsFromListing(ctx.provider, parseModelLines(stdout));
  } finally {
    if (timer !== null) clearTimeout(timer);
    try {
      child.kill();
    } catch {
      // already exited
    }
    ctx.killTree();
  }
}
