import { expect, test } from 'vitest';
import { orderedModels, readFavorites, FAVORITES_KEY } from './model-order';

test('default aliases are hidden even when their ids resolve to a named model', () => {
  expect(orderedModels([{ id: 'claude-opus-5', name: 'Default (recommended)' }, { id: 'auto', name: 'Automatic' }])).toEqual([]);
});
test('only named models are listed, with frontier models ahead of lightweight and legacy ones', () => {
  const models = ['default', 'gpt-6-mini', 'gpt-5.5', 'gpt-6-astra', 'gpt-5.6'].map((id) => ({ id, name: id }));
  expect(orderedModels(models).map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6', 'gpt-5.5', 'gpt-6-mini']);
});
test('favorites survive reload and malformed storage is ignored', () => {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([{ providerId: 'codex', accountId: 'a', model: { id: 'gpt-6-astra', name: 'Astra' } }, null]));
  expect(readFavorites()).toHaveLength(1);
  localStorage.setItem(FAVORITES_KEY, '{');
  expect(readFavorites()).toEqual([]);
  localStorage.removeItem(FAVORITES_KEY);
});
