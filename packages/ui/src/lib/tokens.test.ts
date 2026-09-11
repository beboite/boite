import { describe, expect, test } from 'vitest';
import { contextLevel, contextPercent, formatTokens } from './tokens';

describe('formatTokens', () => {
  test('reads as a count under a thousand, thousands as k, millions with one decimal', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(512)).toBe('512');
    expect(formatTokens(84_400)).toBe('84k');
    expect(formatTokens(199_600)).toBe('200k');
    expect(formatTokens(1_240_000)).toBe('1.2M');
    expect(formatTokens(12_400_000)).toBe('12M');
  });
});

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
