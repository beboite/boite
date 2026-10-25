import { describe, expect, test } from 'vitest';
import { contextLevel, contextPercent } from './tokens';

describe('contextPercent', () => {
  test('is the share of the window, whole, capped, and null without a window', () => {
    expect(contextPercent({ tokens: 84_000, window: 200_000, at: 0 })).toBe(42);
    expect(contextPercent({ tokens: 250_000, window: 200_000, at: 0 })).toBe(100);
    expect(contextPercent({ tokens: 84_000, window: null, at: 0 })).toBeNull();
  });

  test('the level turns high at three quarters and full at nine tenths', () => {
    expect(contextLevel(null)).toBe('low');
    expect(contextLevel(74)).toBe('low');
    expect(contextLevel(75)).toBe('high');
    expect(contextLevel(90)).toBe('full');
  });

  test('uses the lower of the model window and configured compaction threshold', () => {
    const rule = { tokens: 250_000, moments: ['turn-end'] as const };
    const autoCompact = { ...rule, moments: [...rule.moments] };
    expect(contextPercent({ tokens: 212_569, window: 1_000_000, at: 0 }, autoCompact)).toBe(85);
    expect(contextPercent({ tokens: 100_000, window: 128_000, at: 0 }, autoCompact)).toBe(78);
    expect(contextPercent({ tokens: 275_000, window: 1_000_000, at: 0 }, autoCompact)).toBe(100);
    expect(contextPercent({ tokens: 212_569, window: null, at: 0 }, autoCompact)).toBe(85);
    expect(contextPercent({ tokens: 212_569, window: 1_000_000, at: 0 }, { ...autoCompact, tokens: null })).toBe(21);
    expect(contextPercent({ tokens: 212_569, window: 1_000_000, at: 0 }, null)).toBe(21);
  });
});
