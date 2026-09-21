import { describe, expect, it } from 'vitest';
import { switchDropsHistory } from './switch-warning';

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
