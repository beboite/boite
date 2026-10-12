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
});
