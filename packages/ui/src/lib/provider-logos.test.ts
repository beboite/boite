import { expect, test } from 'vitest';
import { modelLogoId, modelMakerName } from './provider-logos';

test('a model shows the mark of its maker, whichever harness runs it', () => {
  expect(modelLogoId('opencode', 'anthropic/claude-opus-5-5')).toBe('claude');
  expect(modelLogoId('claude', 'gpt-6.1-sol')).toBe('codex');
  expect(modelLogoId('opencode', 'openai/o4-mini')).toBe('codex');
  expect(modelLogoId('opencode', 'xai/grok-5')).toBe('grok');
  // Nothing recognised, or the provider's default model: the harness's own mark.
  expect(modelLogoId('opencode', 'moonshot/kimi-k3')).toBe('opencode');
  expect(modelLogoId('pi', null)).toBe('pi');
  // The mark's label names the maker only when it is not the harness itself.
  expect(modelMakerName('claude', 'opencode')).toBe('Anthropic');
  expect(modelMakerName('claude', 'claude')).toBeNull();
});
