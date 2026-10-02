import { expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
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

test('a conversation that handed nothing out shows a title and nothing else', async () => {
  const shown = await show({ delayMs: 0 });
  try {
    expect(document.querySelectorAll('[data-testid=delegation-member], [data-testid=delegation-run]')).toHaveLength(0);
    expect(document.querySelectorAll('textarea, details, p')).toHaveLength(0);
    expect(document.querySelector('[data-testid=delegation-stop-all]')).toBeNull();
    // The owner's settings stay one icon away, closed.
    expect(document.querySelector('[data-testid=delegation-settings]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid=delegation-settings-toggle]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid=delegation-settings] input[role=switch]')).not.toBeNull();
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
    expect([...document.querySelectorAll<HTMLElement>('[data-testid=delegation-member]')].map(row => row.dataset.agentId)).toEqual(agents.map(agent => agent.thread.id));
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
    expect(store.delegationSelectedAgentId).toBe(run.nodes[1]!.instances[0]!.threadId);

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-back]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-graph]')).not.toBeNull();
    expect(store.delegationSelectedAgentId).toBeNull();

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
