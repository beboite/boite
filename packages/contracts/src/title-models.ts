import type { ModelInfo, Protocol } from './index.ts';

/**
 * The small model each provider writes thread titles with when Settings names
 * none. A provider names model families, not ids: the newest listed model of
 * the first family it lists wins, so a new Haiku or Luna is picked up the day
 * the agent lists it. `fallback` is what a provider that lists none of them is
 * asked for, which is what a Codex nobody probed yet gets; Claude's is the
 * CLI's own alias for its newest Haiku.
 */
export interface TitleModelRule {
  /** Matched against model ids, best family first. */
  families: readonly RegExp[];
  fallback: string;
}

export const TITLE_MODEL_DEFAULTS: Readonly<Record<string, TitleModelRule>> = {
  claude: { families: [/(?:^|-)haiku(?:-|$)/i], fallback: 'haiku' },
  codex: { families: [/-luna$/i, /-mini$/i], fallback: 'gpt-6-luna' },
  opencode: { families: [], fallback: 'openai/gpt-5' },
};

/** A provider of another id on the same agent takes that agent's defaults. */
const BY_PROTOCOL: Partial<Record<Protocol, string>> = {
  'claude-sdk': 'claude',
  'codex-appserver': 'codex',
};

/**
 * The version numbers in a model id, a release date left out:
 * `claude-haiku-5-5` is [5, 5], `gpt-5.6-luna` [5, 6],
 * `claude-haiku-4-5-20251001` [4, 5].
 */
function version(id: string): number[] {
  return (id.match(/\d+/g) ?? []).filter((part) => !/^\d{8}$/.test(part)).map(Number);
}

/** Positive when `a` is a newer version than `b`. */
function newer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * The model a provider writes titles with when the user picked none, out of
 * the models it lists. Null for a provider with no small model on record.
 */
export function defaultTitleModel(
  provider: { id: string; protocol: Protocol },
  models: readonly Pick<ModelInfo, 'id'>[],
): string | null {
  const rule = TITLE_MODEL_DEFAULTS[provider.id] ?? TITLE_MODEL_DEFAULTS[BY_PROTOCOL[provider.protocol] ?? ''];
  if (rule === undefined) return null;
  for (const family of rule.families) {
    const listed = models.filter((model) => family.test(model.id) && !model.id.includes('['));
    if (listed.length === 0) continue;
    return listed.reduce((best, model) => (newer(version(model.id), version(best.id)) > 0 ? model : best)).id;
  }
  return rule.fallback;
}
