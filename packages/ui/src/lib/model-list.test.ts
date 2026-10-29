import { expect, test } from 'vitest';
import type { ModelInfo } from '@boite/contracts';
import { FIRST_MODELS, favoriteIds, firstModels, groupModels } from './model-list';

const models = (count: number): ModelInfo[] =>
  Array.from({ length: count }, (_, index) => ({ id: `vendor${index % 3}/model-${index}`, name: `Model ${index}` }) as ModelInfo);

test('a long list keeps its first rows and the current model wherever it sits', () => {
  const all = models(534);
  expect(firstModels(all, () => false)).toHaveLength(FIRST_MODELS);
  const kept = firstModels(all, (model) => model.id === 'vendor1/model-400');
  expect(kept).toHaveLength(FIRST_MODELS + 1);
  expect(kept.at(-1)?.id).toBe('vendor1/model-400');
  // Already among the first rows: nothing is added twice.
  expect(firstModels(all, (model) => model.id === 'vendor0/model-3')).toHaveLength(FIRST_MODELS);
  const short = models(22);
  expect(firstModels(short, () => false)).toBe(short);
});

test('models group by the prefix of their id in first-seen order', () => {
  const groups = groupModels([...models(4), { id: 'bare', name: 'Bare' } as ModelInfo]);
  expect(groups.map((group) => [group.key, group.models.length])).toEqual([['vendor0', 2], ['vendor1', 1], ['vendor2', 1], ['', 1]]);
});

test('gateway groups keep the upstream provider and leave slashes in model names alone', () => {
  const all = [
    { id: 'douane/opencode/minimax-m3.1-flash-free', name: 'MiniMax' },
    { id: 'douane/openrouter/minimax/minimax-m3.1-flash:free', name: 'MiniMax' },
    { id: 'douane/openrouter/cohere/north-mini:free', name: 'North Mini' },
    { id: 'cliproxyapi/opencode_go/kimi-k3', name: 'Kimi' },
    { id: 'openrouter/minimax/minimax-m3.1-flash:free', name: 'Native MiniMax' },
    { id: 'douane/legacy-model', name: 'Legacy' },
  ];
  expect(groupModels(all).map(group => [group.key, group.models.length])).toEqual([
    ['douane/opencode', 1], ['douane/openrouter', 2], ['cliproxyapi/opencode_go', 1], ['openrouter', 1], ['douane', 1],
  ]);
});

test('favorite ids are the ones of this provider account only', () => {
  const model = (id: string) => ({ id, name: id }) as ModelInfo;
  const ids = favoriteIds([
    { providerId: 'opencode', accountId: 'a', model: model('x') },
    { providerId: 'opencode', accountId: 'b', model: model('y') },
    { providerId: 'claude', accountId: 'a', model: model('z') },
  ], 'opencode', 'a');
  expect([...ids]).toEqual(['x']);
});
