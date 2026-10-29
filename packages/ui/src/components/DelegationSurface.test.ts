import { expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { threadBusy } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { workspace, type Machine } from '../lib/workspace.svelte';
import DelegationSurface from './DelegationSurface.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
}

async function show(options: ConstructorParameters<typeof FakeClient>[0]) {
  const client = new FakeClient(options);
  const store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  store.panel.open('agents');
  const shown = { client, store, component: {} };
  await render(shown);
  return shown;
}

/** The panel hands the surface a new object when it changes, the way `RightPanel` does on every update. */
async function render(shown: { store: Store; component: object }): Promise<void> {
  document.body.innerHTML = '';
  shown.component = mount(DelegationSurface, { target: document.body, props: { store: shown.store, surface: shown.store.panel.active!, panel: shown.store.panel } });
  await settle();
}

async function close(shown: Awaited<ReturnType<typeof show>>): Promise<void> {
  await unmount(shown.component);
  shown.store.detach(); shown.client.close(); document.body.innerHTML = ''; window.localStorage.clear();
}

test('a conversation that handed nothing out shows a title and one sentence on how subagents start', async () => {
  const shown = await show({ delayMs: 0 });
  try {
    expect(document.querySelectorAll('[data-testid=delegation-member], [data-testid=delegation-run]')).toHaveLength(0);
    expect(document.querySelectorAll('textarea, details')).toHaveLength(0);
    expect([...document.querySelectorAll('p')].map(p => p.dataset.testid)).toEqual(['delegation-empty']);
    expect(document.querySelector('[data-testid=delegation-empty]')!.textContent).toContain('Ask the agent to split the work');
    expect(document.querySelector('[data-testid=delegation-stop-all]')).toBeNull();
    // The owner's settings stay one icon away, closed.
    expect(document.querySelector('[data-testid=delegation-settings]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid=delegation-settings-toggle]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid=delegation-settings] input[role=switch]')).not.toBeNull();
    // The agent picks any model by default; turning that off reaches the core.
    const any = document.querySelector<HTMLInputElement>('[data-testid=delegation-any-model]')!;
    expect(any.checked).toBe(true);
    any.click();
    await settle();
    expect((await shown.client.call('delegation.get', { threadId: 't-trace' })).config.anyModel).toBe(false);
    expect(document.querySelector<HTMLInputElement>('[data-testid=delegation-any-model]')!.checked).toBe(false);
  } finally {
    await close(shown);
  }
});

test('one list holds the workflow runs and the subagents, and a run opens its graph in place', async () => {
  const shown = await show({ delayMs: 0, delegationDemo: true });
  const { store } = shown;
  try {
    const run = store.workflowsOf('t-trace')[0]!;
    const agents = store.delegation!.agents;
    expect(agents.length).toBeGreaterThan(0);
    // Working subagents and finished ones sit in separate groups, every one of them once.
    const ids = (group: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid=${group}] [data-testid=delegation-member]`)].map(row => row.dataset.agentId);
    const active = agents.filter(agent => threadBusy(agent.thread)).map(agent => agent.thread.id);
    expect(active.length).toBeGreaterThan(0);
    expect(ids('delegation-active')).toEqual(active);
    expect(ids('delegation-finished')).toContain('t-team-done');
    expect(ids('delegation-active').length + ids('delegation-finished').length).toBe(agents.length);
    // A subagent whose turn ended on its own background work is still at work: it says what it waits for, and since when.
    expect(ids('delegation-active')).toContain('t-team-waiting');
    const waiting = document.querySelector<HTMLElement>('[data-agent-id=t-team-waiting]')!;
    expect(waiting.dataset.status).toBe('background');
    expect(waiting.querySelector('[data-testid=delegation-member-wait]')!.textContent).toMatch(/^Waiting on test_emotes\s*1m \d\ds$/);
    // Work that ended without waking it leaves it interrupted, with the reason and a Resume.
    expect(ids('delegation-finished')).toContain('t-team-interrupted');
    const interrupted = document.querySelector<HTMLElement>('[data-agent-id=t-team-interrupted]')!;
    expect(interrupted.dataset.status).toBe('interrupted');
    expect(interrupted.querySelector('.outcome')!.textContent).toBe('Interrupted');
    expect(interrupted.querySelector('[data-testid=delegation-member-wait]')!.textContent).toBe('release build ended without waking it: its agent process was ended');
    expect(document.querySelectorAll('[data-testid=delegation-resume]')).toHaveLength(1);
    // A row leads with the model's mark and name; the task it was given is not repeated there.
    const done = document.querySelector<HTMLElement>('[data-agent-id=t-team-done]')!;
    expect(done.querySelector('[data-logo]')!.getAttribute('data-logo')).toBe('codex');
    expect(done.querySelector('.model')!.textContent).toBe(store.modelOf({ providerId: 'codex', accountId: 'a-codex', model: 'gpt-6.1-sol', effort: null, permissionMode: 'default', speed: null })?.name ?? 'gpt-6.1-sol');
    expect(done.textContent).not.toContain('Review the panel wording');
    const route = done.querySelector('[data-testid=delegation-member-route]')!.getAttribute('title')!;
    expect(route).toContain(store.providerOf('codex')!.name);
    expect(route.split(' · ').length).toBeGreaterThanOrEqual(2);
    const rows = document.querySelectorAll<HTMLButtonElement>('[data-testid=delegation-run]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Review the parser');
    expect(rows[0]!.textContent).toContain('1/5 steps');
    expect(document.querySelectorAll('textarea, [data-testid=coordination-panel]')).toHaveLength(0);

    rows[0]!.click();
    await settle();
    expect(store.panel.active).toMatchObject({ kind: 'agents', runId: run.id });
    await unmount(shown.component);
    await render(shown);
    // jsdom lays nothing out: at zero width the two steps of phase 3 do not fit side by side, so the graph is a list.
    expect(document.querySelector('[data-testid=workflow-graph]')!.getAttribute('data-layout')).toBe('list');
    expect(document.querySelectorAll('[data-testid=workflow-phase]')).toHaveLength(4);
    const nodes = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=workflow-node]')];
    expect(nodes.map(node => node.dataset.status)).toEqual(['done', 'running', 'waiting', 'waiting', 'waiting']);
    expect(nodes[1]!.querySelector('[data-testid=workflow-node-count]')?.textContent).toBe('1/3');

    nodes[1]!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-detail]')?.getAttribute('data-node-id')).toBe('review');
    const instances = document.querySelectorAll<HTMLButtonElement>('[data-testid=workflow-instance]');
    expect(instances).toHaveLength(3);
    instances[0]!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-output]')?.textContent).toContain('"bugs"');
    // The item's conversation is one click away, in the chat: the panel draws none.
    expect(document.querySelector('[data-testid=workflow-open-thread]')?.getAttribute('data-preload-thread')).toBe(run.nodes[1]!.instances[0]!.threadId);
    expect(store.delegationSelectedAgentId).toBeNull();

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-back]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-graph]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-pause]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-resume]')).not.toBeNull();
    expect(document.querySelector('[data-testid=workflow-stop]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-run-back]')!.click();
    await settle();
    expect(store.panel.active?.runId).toBeUndefined();
    await unmount(shown.component);
    await render(shown);
    expect(document.querySelectorAll('[data-testid=delegation-run]')).toHaveLength(1);
  } finally {
    await close(shown);
  }
});

test('a subagent and a step run by one subagent open in the chat, not in the panel', async () => {
  const shown = await show({ delayMs: 0, delegationDemo: true });
  const { store } = shown;
  try {
    document.querySelector<HTMLButtonElement>('[data-agent-id=t-team-done]')!.click();
    await settle();
    expect(store.openThread?.id).toBe('t-team-done');
    expect(store.openThread?.parentThreadId).toBe('t-trace');
    expect(document.querySelector('[data-testid=delegation-detail], [data-testid=delegation-transcript]')).toBeNull();

    await store.open('t-trace');
    const run = store.workflowsOf('t-trace')[0]!;
    const single = run.nodes.find(node => node.instances.length === 1 && node.instances[0]!.threadId)!;
    expect(single).toBeDefined();
    store.panel.update(store.panel.active!.id, { runId: run.id });
    await render(shown);
    document.querySelector<HTMLButtonElement>(`[data-testid=workflow-node][data-node-id=${single.id}]`)!.click();
    await settle();
    expect(store.openThread?.id).toBe(single.instances[0]!.threadId);
    expect(document.querySelector('[data-testid=workflow-detail]')).toBeNull();
  } finally {
    await close(shown);
  }
});

test('a subagent on another machine names that machine, opens on its store, and stays shut while that machine is not connected here', async () => {
  const machine = async (coreId: string) => {
    const client = new FakeClient({ delayMs: 0, coreId, coreName: coreId, publicUrl: `https://${coreId}.test` });
    const store = new Store();
    store.attach(client);
    await store.connect();
    return { client, store, machine: { id: `https://${coreId}.test`, label: coreId === 'pc' ? 'Studio PC' : coreId, store } as Machine };
  };
  const desk = await machine('desk'), pc = await machine('pc');
  const before = { active: workspace.active, machines: workspace.machines };
  let component: object | null = null;
  try {
    await desk.client.call('group.create', { name: 'Home' });
    await pc.client.call('group.join', { invite: (await desk.client.call('group.invite', {})).invite });
    await pc.client.call('settings.set', { groupThreads: true });
    // Ids are per machine: the child there will take an id this machine gives one of its own threads below.
    const create = (on: typeof desk) => on.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    const number = (thread: { id: string }) => Number(thread.id.slice(2));
    const ahead = number(await create(desk)) + 3;
    while (number(await create(pc)) < ahead);
    const child = await desk.client.call('delegation.spawn', { threadId: 't-trace', task: 'Read the notes', machine: 'pc', requestId: 'remote-row' });
    workspace.machines = [desk.machine, pc.machine];
    workspace.active = desk.store;
    await desk.store.open('t-trace');
    desk.store.panel.open('agents');
    component = mount(DelegationSurface, { target: document.body, props: { store: desk.store, surface: desk.store.panel.active!, panel: desk.store.panel } });
    await settle();

    const row = () => document.querySelector<HTMLButtonElement>(`[data-agent-id="${child.thread.id}"]`)!;
    // The chip names the machine as this window lists it; a local subagent has none.
    expect(row().querySelector('[data-testid=delegation-member-machine]')!.textContent).toBe('Studio PC');
    expect(document.querySelectorAll('[data-testid=delegation-member-machine]')).toHaveLength(1);
    expect(row().getAttribute('aria-disabled')).toBeNull();
    expect(row().dataset.machineId).toBe(pc.machine.id);

    // It opens on the machine that runs it, never in the parent's store, where the same id may be another thread.
    row().click();
    await settle();
    expect(workspace.active).toBe(pc.store);
    expect(pc.store.openThread?.id).toBe(child.thread.id);
    expect(desk.store.openThread?.id).toBe('t-trace');

    // A thread of this machine under the same id changing does not rewrite the row of the one there.
    workspace.active = desk.store;
    await desk.store.open('t-trace');
    await settle();
    let twin = await create(desk);
    while (number(twin) < number(child.thread)) twin = await create(desk);
    expect(twin!.id).toBe(child.thread.id);
    await desk.client.call('threads.update', { threadId: twin!.id, title: 'A thread of this machine' });
    await settle();
    expect(row().querySelector('.title')!.textContent).toBe(child.thread.title);

    // That machine not connected here: the row still reads, says why, and opens nothing.
    workspace.machines = [desk.machine];
    await settle();
    expect(row().querySelector('[data-testid=delegation-member-machine]')!.textContent).toBe('pc');
    expect(row().getAttribute('aria-disabled')).toBe('true');
    expect(row().getAttribute('data-preload-thread')).toBeNull();
    expect(row().title).toBe('pc is not connected here. Connect it in Settings, Machines and updates to open this subagent.');
    expect(row().querySelector('[data-testid=delegation-member-away]')!.textContent).toBe(row().title);
    row().click();
    await settle();
    expect(workspace.active).toBe(desk.store);
    expect(desk.store.openThread?.id).toBe('t-trace');
  } finally {
    if (component) await unmount(component);
    workspace.active = before.active; workspace.machines = before.machines;
    for (const { client, store } of [desk, pc]) { store.detach(); client.close(); }
    document.body.innerHTML = ''; window.localStorage.clear();
  }
});
