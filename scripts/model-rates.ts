/**
 * Regenerates `packages/core/src/pricing/rates.json`, the public API rates the
 * usage page prices tokens at, from the models.dev catalogue OpenCode also reads.
 *
 *   bun scripts/model-rates.ts                       # fetch https://models.dev/api.json
 *   bun scripts/model-rates.ts ~/.cache/opencode/models.json
 *
 * Only the model makers' own listings are kept, in the order below: when two
 * makers list the same id (a GLM model resold by Alibaba), the first one wins.
 * Image, audio, vision and embedding models are left out, and so are a model
 * with no input or output rate, one released before 2025, an open-weight size
 * variant that third parties serve at their own prices, a dated alias of a
 * model listed at the same rates, and a reseller's copy (`zai-glm-5-3`).
 * Each model is `[input, output, cacheRead, cacheWrite]` in USD per million
 * tokens at the base tier, null where the catalogue gives no rate: the table
 * ships inside the core bundle, which has a size budget.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'https://models.dev/api.json';
const MAKERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'minimax', 'mistral', 'alibaba', 'meta'] as const;
const OUT = join(import.meta.dir, '..', 'packages', 'core', 'src', 'pricing', 'rates.json');
const SINCE = '2025-01-01';
/** Speech, vision and computer-use builds, reseller copies and open-weight sizes such as `qwen3-14b` or `qwen3.6-35b-a3b`. */
const SKIPPED = /embedding|asr|voxtral|-vl\b|vl-|qvq|omni|vision|computer-use|^glm-[\d.]+v|v-turbo|^zai-|-\d+b(?:-a\d+b)?(?:-|$)/;
/** The release dates `priceOf` strips before it looks again (`packages/core/src/pricing/index.ts`); only those aliases can go. */
const DATED = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;

interface Listed {
  release_date?: string;
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

type Rate = [input: number, output: number, cacheRead: number | null, cacheWrite: number | null];

function price(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

async function catalogue(from: string | undefined): Promise<Record<string, { models?: Record<string, Listed> }>> {
  if (from !== undefined) return JSON.parse(readFileSync(from, 'utf8'));
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`${SOURCE}: HTTP ${response.status}`);
  return (await response.json()) as Record<string, { models?: Record<string, Listed> }>;
}

const data = await catalogue(process.argv[2]);
const models: Record<string, Rate> = {};
for (const maker of MAKERS) {
  const listed = data[maker]?.models;
  if (listed === undefined) throw new Error(`${maker}: missing from the catalogue`);
  for (const [rawId, model] of Object.entries(listed)) {
    const id = rawId.toLowerCase();
    if (id in models) continue;
    const output = model.modalities?.output ?? ['text'];
    if (output.length !== 1 || output[0] !== 'text' || (SKIPPED.test(id) && !id.includes('coder'))) continue;
    if ((model.release_date ?? '') < SINCE) continue;
    const input = price(model.cost?.input);
    const out = price(model.cost?.output);
    if (input === null || out === null || input + out === 0) continue;
    models[id] = [input, out, price(model.cost?.cache_read), price(model.cost?.cache_write)];
  }
}

// The core strips a date before it looks again, so `claude-haiku-4-5-20251001` finds `claude-haiku-4-5`.
for (const id of Object.keys(models)) {
  const base = id.replace(DATED, '');
  if (base !== id && JSON.stringify(models[base]) === JSON.stringify(models[id])) delete models[id];
}
const ids = Object.keys(models).sort();
const lines = ids.map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(models[id])}`);
const date = new Date().toISOString().slice(0, 10);
writeFileSync(OUT, `{\n  "source": ${JSON.stringify(SOURCE)},\n  "date": ${JSON.stringify(date)},\n  "models": {\n${lines.join(',\n')}\n  }\n}\n`);
console.log(`${ids.length} models written to ${OUT}`);
