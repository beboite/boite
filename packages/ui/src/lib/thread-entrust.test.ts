import { afterEach, beforeEach, expect, test } from 'vitest';
import type { AgentsSnapshot, ThreadSummary } from '@boite/contracts';
import { setExperiment } from './experiments';
import { agentDirectory } from './agent-directory.svelte';
import { entrustItems } from './thread-entrust';
import type { Store } from './store.svelte';

beforeEach(() => { setExperiment('resident-agents', true); });
afterEach(() => { setExperiment('resident-agents', false); });

const thread = (patch: Partial<ThreadSummary> = {}) => ({ id: 't1', projectId: 'p1', parentThreadId: null, archived: false, incognito: false, ...patch } as ThreadSummary);
const profile = (id: string, status = 'active') => ({ id, name: id === 'mira' ? 'Mira' : 'Lin', status, domain: '', avatar: '' });

test('a thread menu offers its agents, then the way to take the thread back', () => {
  const store = { owner: true, threads: [thread()] } as unknown as Store;
  const directory = agentDirectory(store);
  // Nothing to offer before the agents are read, or with none active.
  expect(entrustItems(store, thread())).toEqual([]);
  directory.snapshot = { profiles: [profile('lin', 'paused')], entrusted: [] } as unknown as AgentsSnapshot;
  expect(entrustItems(store, thread())).toEqual([]);
  directory.snapshot = { profiles: [profile('mira'), profile('lin', 'paused')], entrusted: [] } as unknown as AgentsSnapshot;
  expect(entrustItems(store, thread()).map(i => i.id)).toEqual(['entrust']);
  expect(directory.agents.map(a => a.id)).toEqual(['mira']);
  directory.snapshot = { profiles: [profile('mira')], entrusted: [{ threadId: 't1', agentId: 'mira', objective: 'Ship', at: 1 }] } as unknown as AgentsSnapshot;
  expect(entrustItems(store, thread()).map(i => [i.id, i.hint])).toEqual([['entrust-back', 'Entrusted to Mira']]);
  // Children, agent sessions, archived and incognito threads, and paired devices get nothing.
  for (const other of [thread({ parentThreadId: 'p' }), thread({ agentSessionId: 's' }), thread({ archived: true }), thread({ incognito: true }), thread({ projectId: null })]) expect(entrustItems(store, other)).toEqual([]);
  expect(entrustItems({ ...store, owner: false } as unknown as Store, thread())).toEqual([]);
});
