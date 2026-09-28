import type { ModelInfo, Protocol } from './index.ts';

/**
 * The small model each provider writes thread titles with when Settings names
 * none, T3 Code's picks. Tried in order against what the provider lists; a
 * provider that lists none of them is asked for the first anyway, which is
 * what a Codex nobody probed yet gets.
 */
export const TITLE_MODEL_DEFAULTS: Readonly<Record<string, readonly string[]>> = {
  claude: ['claude-haiku-4-5'],
  codex: ['gpt-6-luna', 'gpt-5.6-luna', 'gpt-5.4-mini'],
  opencode: ['openai/gpt-5'],
};

/** A provider of another id on the same agent takes that agent's defaults. */
const BY_PROTOCOL: Partial<Record<Protocol, string>> = {
  'claude-sdk': 'claude',
  'codex-appserver': 'codex',
};

/** `claude-haiku-4-5-20251001` names `claude-haiku-4-5`: a date after the name is the same model. */
function names(id: string, wanted: string): boolean {
  return id === wanted || (id.startsWith(`${wanted}-`) && /^\d{8}$/.test(id.slice(wanted.length + 1)));
}

/**
 * The model a provider writes titles with when the user picked none, out of
 * the models it lists. Null for a provider with no small model on record.
 */
export function defaultTitleModel(
  provider: { id: string; protocol: Protocol },
  models: readonly Pick<ModelInfo, 'id'>[],
): string | null {
  const wanted = TITLE_MODEL_DEFAULTS[provider.id] ?? TITLE_MODEL_DEFAULTS[BY_PROTOCOL[provider.protocol] ?? ''];
  if (wanted === undefined) return null;
  for (const candidate of wanted) {
    const listed = models.find((model) => names(model.id, candidate));
    if (listed !== undefined) return listed.id;
  }
  return wanted[0] ?? null;
}
