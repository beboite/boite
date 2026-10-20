/**
 * How capable a model is, for contact traffic. Read off the provider and model
 * ids by pattern: a new model of a known family lands in its family's tier
 * without a table to update. A tier is a cost and cooperation rule between two
 * owners, not a security boundary: the sender's model is its core's word.
 */
import type { ModelTier } from '@boite/contracts';
import { invalidParams } from '../errors.ts';

const SMALL = new Set(['haiku', 'lite', 'oss', 'mini', 'nano']);
const FRONTIER = new Set(['opus', 'fable', 'sol', 'luna']);

export function modelTier(providerId: string, model: string | null | undefined): ModelTier {
  const name = `${providerId} ${model ?? ''}`.toLowerCase();
  const words = name.split(/[^a-z0-9]+/).filter(Boolean);
  // The smallest marker wins: `gpt-6-mini` is small, `gemini-pro-lite` too.
  if (words.some(word => SMALL.has(word))) return 3;
  if (words.some(word => FRONTIER.has(word)) || /(^|[^a-z0-9])gpt-?6(?![0-9])/.test(name)) return 1;
  if (words.includes('gemini') && words.includes('pro')) return 1;
  if (words.includes('sonnet') || words.includes('flash')) return 2;
  return 2;
}

/** The tier of `provider model`, as a thread's directory entry names its agent; unknown without one. */
export function attestedTier(agent: string | undefined): ModelTier {
  if (typeof agent !== 'string' || !agent.trim()) return 2;
  const cut = agent.indexOf(' ');
  return cut < 0 ? modelTier(agent, null) : modelTier(agent.slice(0, cut), agent.slice(cut + 1));
}

/** A model may carry contact traffic when it is at least as capable as `minTier` asks: tier 1 is the most capable. */
export function tierAllowed(tier: ModelTier, minTier: ModelTier): boolean {
  return tier <= minTier;
}

export function checkTier(value: unknown, field: string): ModelTier {
  if (value !== 1 && value !== 2 && value !== 3) throw invalidParams(`${field}: expected 1, 2 or 3`, { field });
  return value;
}
