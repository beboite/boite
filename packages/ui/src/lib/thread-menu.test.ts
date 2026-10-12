import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { AgentsSnapshot, ThreadSummary } from '@boite/contracts';
import { setExperiment } from './experiments';
import { agentDirectory } from './agent-directory.svelte';
import { pickThreadAction, threadMenuItems } from './thread-menu';
import type { Store } from './store.svelte';

beforeEach(() => { setExperiment('resident-agents', true); });
afterEach(() => { setExperiment('resident-agents', false); });

const thread = (patch: Partial<ThreadSummary> = {}) => ({ id: 't1', title: 'Port', cwd: '/w', projectId: 'p1', parentThreadId: null, agentSessionId: null, archived: false, incognito: false, pinned: false, status: 'idle', ...patch } as ThreadSummary);
const stub = () => ({
  owner: true,
  connection: 'ready',
  retitling: [],
  composerStates: {},
  threads: [thread()],
  moveBlocked: () => false,
  client: { call: vi.fn(async () => ({})) }
}) as unknown as Store & { client: { call: ReturnType<typeof vi.fn> } };

test('every thread menu offers Move only to a thread the core lets change project', () => {
  const store = stub();
  const ids = (t: ThreadSummary) => threadMenuItems(store, t, { open: false, showDone: true, prLoading: false }).map(item => item.id);
  expect(ids(thread())).toContain('move');
  // Outside any project, a persistent agent's session, a sub-thread, archived or incognito: the core refuses each.
  for (const other of [thread({ projectId: null }), thread({ agentSessionId: 's1' }), thread({ parentThreadId: 't0' }), thread({ archived: true }), thread({ incognito: true })])
    expect(ids(other)).not.toContain('move');
});

test('a pick from any thread menu, the phone list included, reaches the entrust rows', () => {
  const store = stub();
  agentDirectory(store).snapshot = { profiles: [{ id: 'mira', name: 'Mira', status: 'active', domain: '', avatar: '' }], entrusted: [{ threadId: 't1', agentId: 'mira', objective: 'Ship', at: 1 }] } as unknown as AgentsSnapshot;
  expect(threadMenuItems(store, thread()).map(item => item.id)).toContain('entrust-back');
  const rename = vi.fn();
  expect(pickThreadAction(store, thread(), 'entrust-back', { rename })).toBe(true);
  expect(store.client.call).toHaveBeenCalledWith('agents.entrust', { threadId: 't1', agentId: null });
  expect(pickThreadAction(store, thread(), 'rename', { rename })).toBe(true);
  expect(rename).toHaveBeenCalledOnce();
  // A row the view added itself stays the view's.
  expect(pickThreadAction(store, thread(), 'coordination', { rename })).toBe(false);
});
