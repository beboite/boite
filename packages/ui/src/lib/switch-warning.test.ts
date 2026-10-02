import { describe, expect, it } from 'vitest';
import { CACHE_LIFETIME_MS, switchDropsHistory, switchResetsCache } from './switch-warning';

const context = (tokens: number) => ({ tokens, window: 1_000_000, at: 0 });

describe('switchDropsHistory', () => {
  it('asks before a long thread moves to another account', () => {
    expect(switchDropsHistory({ accountId: 'a', context: context(200_001) }, 'b')).toBe(true);
  });

  it('stays quiet on a model change within the account, which keeps the session', () => {
    expect(switchDropsHistory({ accountId: 'a', context: context(900_000) }, 'a')).toBe(false);
  });

  it('stays quiet at or under the threshold and on a thread with no reading', () => {
    expect(switchDropsHistory({ accountId: 'a', context: context(200_000) }, 'b')).toBe(false);
    expect(switchDropsHistory({ accountId: 'a', context: null }, 'b')).toBe(false);
  });
});

describe('switchResetsCache', () => {
  const now = 10_000_000;
  const warm = (tokens: number) => ({ context: { tokens, window: 1_000_000, at: now - 60_000 } });
  const key = { accountId: 'a', protocol: 'claude-sdk' as const, model: 'opus', effort: 'high', speed: null };

  it('asks before a long warm thread changes model, effort or speed', () => {
    expect(switchResetsCache(warm(100_001), key, { ...key, model: 'sonnet' }, now)).toBe(true);
    expect(switchResetsCache(warm(100_001), key, { ...key, effort: 'low' }, now)).toBe(true);
    expect(switchResetsCache(warm(100_001), key, { ...key, speed: 'fast' }, now)).toBe(true);
  });

  it('stays quiet when nothing the cache is keyed on changes', () => {
    expect(switchResetsCache(warm(900_000), key, { ...key }, now)).toBe(false);
  });

  it('does not warn for Codex service tiers, but still warns when a speed variant changes the model', () => {
    const codex = { ...key, protocol: 'codex-appserver' as const, model: 'gpt-6-astra' };
    const fast = { ...codex, speed: 'fast' };
    expect(switchResetsCache(warm(900_000), codex, fast, now)).toBe(false);
    expect(switchResetsCache(warm(900_000), fast, { ...fast, speed: 'ultrafast' }, now)).toBe(false);
    expect(switchResetsCache(warm(900_000), fast, codex, now)).toBe(false);
    expect(switchResetsCache(warm(900_000), codex, { ...fast, model: 'gpt-6-astra-fast' }, now)).toBe(true);
  });

  it('warns when enabling Claude fast, while returning to standard keeps the cache', () => {
    const fast = { ...key, speed: 'fast' };
    expect(switchResetsCache(warm(900_000), key, fast, now)).toBe(true);
    expect(switchResetsCache(warm(900_000), fast, key, now)).toBe(false);
    const unknown = { ...key, protocol: null };
    expect(switchResetsCache(warm(900_000), unknown, { ...unknown, speed: 'fast' }, now)).toBe(true);
  });

  it('leaves another account to switchDropsHistory', () => {
    expect(switchResetsCache(warm(900_000), key, { ...key, accountId: 'b', effort: 'low' }, now)).toBe(false);
  });

  it('stays quiet at or under the threshold, with no reading, and from the hour the cache expires', () => {
    expect(switchResetsCache(warm(100_000), key, { ...key, effort: 'low' }, now)).toBe(false);
    expect(switchResetsCache({ context: null }, key, { ...key, effort: 'low' }, now)).toBe(false);
    const at = (age: number) => ({ context: { tokens: 900_000, window: 1_000_000, at: now - age } });
    expect(switchResetsCache(at(CACHE_LIFETIME_MS - 1), key, { ...key, effort: 'low' }, now)).toBe(true);
    expect(switchResetsCache(at(CACHE_LIFETIME_MS), key, { ...key, effort: 'low' }, now)).toBe(false);
  });
});
