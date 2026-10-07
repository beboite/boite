import { expect, test } from 'vitest';
import type { HarnessUpdate } from '@boite/contracts';
import { machineUpdateState } from './machine-updates';

const agent = (patch: Partial<HarnessUpdate> = {}): HarnessUpdate => ({
  providerId: 'claude', name: 'Claude', route: 'managed', current: '1.0.0', latest: '1.0.0', pending: false, skipped: null,
  state: 'idle', message: null, checkedAt: 1, ...patch
});

test('a machine row reads its updates as one word, the most pressing first', () => {
  // Nothing has answered yet: the row says nothing rather than "Up to date".
  expect(machineUpdateState({ server: null, app: null, agents: [] })).toBeNull();
  expect(machineUpdateState({ server: { phase: 'idle' }, app: null, agents: [agent({ checkedAt: null })] })).toBeNull();
  expect(machineUpdateState({ server: { phase: 'current' }, app: null, agents: [agent()] })).toBe('current');
  expect(machineUpdateState({ server: { phase: 'checking' }, app: null, agents: [agent()] })).toBe('checking');
  // One agent with a release waiting is enough, whatever Boite itself says.
  expect(machineUpdateState({ server: { phase: 'current' }, app: null, agents: [agent(), agent({ latest: '1.1.0', pending: true })] })).toBe('available');
  // A release the user skipped is not offered again.
  expect(machineUpdateState({ server: { phase: 'current' }, app: null, agents: [agent({ latest: '1.1.0', pending: true, skipped: '1.1.0' })] })).toBe('current');
  // The desktop app's downloaded release waits for a restart: still something to do.
  expect(machineUpdateState({ server: null, app: { phase: 'ready' }, agents: [agent()] })).toBe('available');
  expect(machineUpdateState({ server: { phase: 'downloading' }, app: null, agents: [agent({ latest: '1.1.0', pending: true })] })).toBe('updating');
  expect(machineUpdateState({ server: { phase: 'installing' }, app: null, agents: [agent({ state: 'failed' })] })).toBe('failed');
});
