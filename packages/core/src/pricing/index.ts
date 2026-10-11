import type { TokenRates, Usage, UsagePrice } from '@boite/contracts';
import list from './rates.json';

/**
 * Public API rates per model, from `rates.json`, which `scripts/model-rates.ts`
 * regenerates from models.dev: `[input, output, cacheRead, cacheWrite]` in USD
 * per million tokens at the base tier, null where the list gives no rate. A
 * request over a long-context threshold costs more on some models, and the
 * journal keeps one sum per turn, not each request's size.
 */
const MODELS: Record<string, (number | null)[]> = list.models;

/** A reasoning effort or a release date a harness appends to the model id. */
const EFFORT = /-(?:minimal|low|medium|high|xhigh|max)$/;
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
/** OpenAI prices a Codex build of a model, and its `max` reasoning mode, as the model itself. */
const CODEX = /-codex(?:-max)?$/;

function listed(model: string): [string, (number | null)[]] | null {
  // `claude/claude-opus-5-5`, `anthropic.claude-opus-5-5`, `claude-opus-5-5@20260922`, `claude-opus-5-5[1m]`.
  let id = model.trim().toLowerCase().replace(/\[[^\]]*\]$/, '').replace(/@[^/]*$/, '');
  id = id.slice(id.lastIndexOf('/') + 1).replace(/^(?:anthropic|openai|google|xai|meta)\./, '');
  for (const strip of [null, EFFORT, DATED, CODEX]) {
    if (strip !== null) id = id.replace(strip, '');
    const found = MODELS[id];
    if (found !== undefined) return [id, found];
  }
  return null;
}

/**
 * The public rates a turn on `model` is charged, or null when the list has no
 * such model. `hourCache` is true for Claude Code, which writes its prompt
 * cache for an hour: Anthropic bills that write at twice the input rate, the
 * listed write rate being the five-minute one. A rate the list leaves out is
 * the input rate, which is what a provider without a cache discount charges.
 */
export function priceOf(model: string | null, hourCache = false): UsagePrice | null {
  if (model === null || model.trim() === '') return null;
  const found = listed(model);
  if (found === null) return null;
  const [id, [input = 0, output = 0, cacheRead = null, listedWrite = null]] = found;
  if (input === null || output === null) return null;
  // Every Anthropic id in the list starts with `claude-`.
  const cacheWrite = hourCache && id.startsWith('claude-') ? input * 2 : (listedWrite ?? input);
  const rates: TokenRates = { input, output, cacheRead: cacheRead ?? input, cacheWrite };
  return { model: id, rates };
}

/** What these tokens cost at these rates, in USD. `usage.inputTokens` must exclude the cache reads. */
export function costAt(rates: TokenRates, usage: Usage): number {
  return (
    usage.inputTokens * rates.input +
    usage.outputTokens * rates.output +
    usage.cacheReadTokens * rates.cacheRead +
    usage.cacheWriteTokens * rates.cacheWrite
  ) / 1_000_000;
}
