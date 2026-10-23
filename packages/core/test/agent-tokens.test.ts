import { expect, test } from 'bun:test';
import { AgentTokens } from '../src/agent.ts';

test('a removed thread leaves the sealed set, an archived one stays sealed', () => {
  const tokens = new AgentTokens();
  tokens.tokenFor('thr_memory');
  tokens.seal('thr_memory');
  tokens.seal('thr_archived');
  // Archiving forgets the token but keeps the seal: a restored memory pass still opens nothing.
  tokens.forget('thr_archived');
  expect(tokens.authenticate(tokens.tokenFor('thr_archived'))).toBeNull();
  // Removing the thread forgets the seal too, so the set does not grow with every memory pass.
  tokens.forget('thr_memory', true);
  tokens.seal('thr_never_minted');
  tokens.forget('thr_never_minted', true);
  expect(tokens.authenticate(tokens.tokenFor('thr_memory'))).toBe('thr_memory');
  expect(tokens.authenticate(tokens.tokenFor('thr_never_minted'))).toBe('thr_never_minted');
});
