import { expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../../test/fake-client';
import { AgentsView, agentOfThread, agentRows } from '../../lib/agents.svelte';
import { setExperiment } from '../../lib/experiments';
import AgentsPage from './AgentsPage.svelte';

test('an agent named on the way in opens alone: the default agent of the visit gives way to it', async ({ ready }) => {
  setExperiment('resident-agents', true);
  let page: ReturnType<typeof mount> | null = null;
  try {
    const { store, client } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const rows = agentRows(view.snapshot);
    const named = rows.at(-1)!.profile;
    expect(named.id).not.toBe(rows[0]!.profile.id);
    // An ordinary thread is open when a link names the agent.
    expect(store.openThread?.agentSessionId).toBeFalsy();
    const call = vi.spyOn(client, 'call');
    store.showAgents(named.id);
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    await vi.waitFor(() => expect(store.openThread?.agentSessionId).toBeTruthy());
    await new Promise(resolve => setTimeout(resolve, 50));
    const opened = call.mock.calls.filter(([method]) => method === 'agents.open').map(([, params]) => (params as { agentId: string }).agentId);
    expect(opened).toEqual([named.id]);
    expect(agentOfThread(view.snapshot, store.openThread!.id)?.id).toBe(named.id);
  } finally {
    if (page) unmount(page);
    setExperiment('resident-agents', false);
  }
});
