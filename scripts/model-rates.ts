/**
 * Regenerates `packages/core/src/pricing/rates.json`, the public API rates the
 * usage page prices tokens at, from the models.dev catalogue OpenCode also reads.
 *
 *   bun scripts/model-rates.ts                       # fetch https://models.dev/api.json
 *   bun scripts/model-rates.ts ~/.cache/opencode/models.json
 *
 * Only the model makers' own listings are kept, in the order below: when two
 * makers list the same id (a GLM model resold by Alibaba), the first one wins.
 * Image, audio and embedding models are left out, and so is a model with no
 * input or output rate. Prices are USD per million tokens, base tier.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = 'https://models.dev/api.json';
const MAKERS = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'minimax', 'mistral', 'alibaba', 'meta'] as const;
const OUT = join(import.meta.dir, '..', 'packages', 'core', 'src', 'pricing', 'rates.json');

interface Listed {
  name?: string;
  modalities?: { output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
}

interface Rate {
  name: string;
  maker: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
}

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
    if (output.length !== 1 || output[0] !== 'text' || id.includes('embedding')) continue;
    const input = price(model.cost?.input);
    const out = price(model.cost?.output);
    if (input === null || out === null || input + out === 0) continue;
    models[id] = {
      name: model.name ?? rawId,
      maker,
      input,
      output: out,
      cacheRead: price(model.cost?.cache_read),
      cacheWrite: price(model.cost?.cache_write),
    };
  }
}

const ids = Object.keys(models).sort((a, b) => models[a]!.maker.localeCompare(models[b]!.maker) || a.localeCompare(b));
const lines = ids.map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(models[id])}`);
const date = new Date().toISOString().slice(0, 10);
writeFileSync(OUT, `{\n  "source": ${JSON.stringify(SOURCE)},\n  "date": ${JSON.stringify(date)},\n  "models": {\n${lines.join(',\n')}\n  }\n}\n`);
console.log(`${ids.length} models written to ${OUT}`);
