import { expect, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { test } from '../../test/fake-client';
import { AgentsView, agentOfThread, agentRows, openAgent } from '../../lib/agents.svelte';
import { setExperiment } from '../../lib/experiments';
import { rightPanel } from '../../lib/right-panel.svelte';
import { strings } from '../../lib/strings';
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

for (const previousBot of [false, true]) test(`a background reload preserves a pending bot selection (previous bot: ${previousBot})`, async ({ ready }) => {
  setExperiment('resident-agents', true);
  let page: ReturnType<typeof mount> | null = null;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  try {
    const { store, client } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const rows = agentRows(view.snapshot);
    if (previousBot) await openAgent(store, rows[0]!.profile.id);
    else await store.open('t-trace');
    const named = rows.at(-1)!.profile;
    const call = client.call.bind(client);
    let opening = false;
    vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
      if (method === 'agents.open') { opening = true; await gate; }
      return call(method, params);
    });
    store.showAgents(named.id);
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    await vi.waitFor(() => expect(opening).toBe(true));
    await store.reload();
    release();
    await vi.waitFor(() => expect(agentOfThread(view.snapshot, store.openThread?.id)?.id).toBe(named.id));
    flushSync();
    expect(document.querySelector('[data-testid="agent-header"]')?.textContent).toContain(named.name);
    expect(document.querySelector('.agents-main [data-testid="composer-input"]')).not.toBeNull();
    expect(document.querySelector('.agents-main .agent-empty')).toBeNull();
  } finally {
    release();
    if (page) await unmount(page);
    setExperiment('resident-agents', false);
  }
});

test('an open settings sheet stays open while the snapshot and the thread row change under it', async ({ ready }) => {
  setExperiment('resident-agents', true);
  let page: ReturnType<typeof mount> | null = null;
  try {
    const { store } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const agent = agentRows(view.snapshot)[0]!.profile;
    store.showAgents(agent.id, 'settings');
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    const sheet = () => document.querySelector('[data-testid="agent-sheet"]');
    await vi.waitFor(() => expect(sheet()).not.toBeNull());
    // A status tick: the same agent, a new snapshot object.
    const before = view.snapshot;
    await view.refresh();
    expect(view.snapshot).not.toBe(before);
    flushSync();
    expect(sheet()?.classList.contains('closing')).toBe(false);
    // The open thread read again: the same thread, a new object.
    store.openThread = { ...store.openThread! };
    flushSync();
    expect(sheet()?.classList.contains('closing')).toBe(false);
  } finally {
    if (page) unmount(page);
    setExperiment('resident-agents', false);
  }
});

test('a desk kept shut by an open panel opens on the next visit: the first visit is not spent', async ({ ready }) => {
  setExperiment('resident-agents', true);
  // No desk seen and no panel left by an earlier test.
  localStorage.clear();
  rightPanel.load();
  let page: ReturnType<typeof mount> | null = null;
  try {
    const { store } = await ready({ delayMs: 0, agentsDemo: true });
    const view = AgentsView.of(store);
    await view.refresh();
    const agent = agentRows(view.snapshot)[0]!.profile;
    await openAgent(store, agent.id);
    // The thread's panel already holds a surface: the desk does not push it aside.
    store.panel.open('files');
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(store.panel.surfaces.map(s => s.kind)).toEqual(['files']);
    unmount(page); page = null;
    store.panel.closeAll();
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    await vi.waitFor(() => expect(store.panel.surfaces.map(s => s.kind)).toEqual(['desk']));
  } finally {
    if (page) unmount(page);
    setExperiment('resident-agents', false);
  }
});

test('a default bot that cannot be opened offers a retry instead of loading forever', async ({ ready }) => {
  setExperiment('resident-agents', true);
  let page: ReturnType<typeof mount> | null = null;
  try {
    const { store, client } = await ready({ delayMs: 0, agentsDemo: true });
    await AgentsView.of(store).refresh();
    const call = client.call.bind(client);
    let refuse = true;
    vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => method === 'agents.open' && refuse
      ? Promise.reject(new Error('agents.open: the core is busy')) : call(method as never, params as never)) as typeof client.call);
    page = mount(AgentsPage, { target: document.body, props: { store } });
    flushSync();
    const retry = () => document.querySelector<HTMLButtonElement>('[data-testid="agents-open-retry"]');
    await vi.waitFor(() => expect(retry()).not.toBeNull());
    expect(document.querySelector('[data-testid="agents-page"]')?.textContent).not.toContain(strings.app.loading);
    refuse = false;
    retry()!.click();
    await vi.waitFor(() => expect(store.openThread?.agentSessionId).toBeTruthy());
  } finally {
    if (page) unmount(page);
    setExperiment('resident-agents', false);
  }
});
