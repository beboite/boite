import { expect, test } from 'vitest';
import type { ModelInfo } from '@boite/contracts';
import { speedControl } from './model-speeds';

const choice = { providerId: 'grok', accountId: 'account', permissionMode: 'default' as const, model: 'grok-4.7', effort: 'high', speed: null };
const effort = { default: 'low', levels: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] };
const models: ModelInfo[] = [{ id: 'grok-4.7', name: 'Grok 4.7', effort }, { id: 'grok-4.7-fast', name: 'Grok 4.7 Fast', effort }];

test('separate fast variants switch model ids, preserve supported effort and return to standard', () => {
  const control = speedControl(models, choice);
  expect(control.speeds.map(entry => entry.id)).toEqual(['grok-4.7-fast']);
  const patch = control.pick('grok-4.7-fast');
  expect(patch).toEqual({ model: 'grok-4.7-fast', effort: 'high', speed: null });
  const fast = speedControl(models, { ...choice, ...patch });
  expect(fast.speed).toBe('grok-4.7-fast');
  expect(fast.pick(null)).toEqual({ model: 'grok-4.7', effort: 'high', speed: null });
});

test('only variants offered by this account form a pair, and an unsupported effort resets', () => {
  expect(speedControl([models[1]!], { ...choice, model: models[1]!.id }).speeds).toEqual([]);
  expect(speedControl([...models.slice(0, 1), { id: 'other/grok-4.7-fast', name: 'Grok Fast' }], choice).speeds).toEqual([]);
  expect(speedControl([models[0]!, { ...models[1]!, effort: { default: 'low', levels: [effort.levels[0]!] } }], choice).pick('grok-4.7-fast').effort).toBe('low');
});
