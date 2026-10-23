import { expect, test } from 'bun:test';
import { AgentTokens } from '../src/agent.ts';

test('forgetting a sealed thread forgets the seal too, so the set does not grow with every memory pass', () => {
  const tokens = new AgentTokens();
  tokens.tokenFor('thr_memory');
  tokens.seal('thr_memory');
  tokens.forget('thr_memory');
  tokens.seal('thr_never_minted');
  tokens.forget('thr_never_minted');
  // A thread id seen again later is a new thread: its token opens it.
  expect(tokens.authenticate(tokens.tokenFor('thr_memory'))).toBe('thr_memory');
  expect(tokens.authenticate(tokens.tokenFor('thr_never_minted'))).toBe('thr_never_minted');
});
