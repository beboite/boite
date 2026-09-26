import { expect, test } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import WorkflowSurface from './WorkflowSurface.svelte';

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
    await tick();
  }
  flushSync();
}

test('the surface reads a narrow run as phases, opens a step and comes back to the graph', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let component;
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation();
    const surface = store.panel.openWorkflow();
    component = mount(WorkflowSurface, { target: document.body, props: { store, surface, panel: store.panel } });
    await settle();

    // jsdom lays nothing out: zero width, so the graph is the phone's list.
    const graph = document.querySelector('[data-testid=workflow-graph]')!;
    expect(graph.getAttribute('data-layout')).toBe('phases');
    expect(document.querySelectorAll('[data-testid=workflow-column]')).toHaveLength(4);
    expect(document.querySelector('[data-testid=workflow-meta]')?.textContent).toContain('1/4 steps');
    const nodes = [...document.querySelectorAll<HTMLButtonElement>('[data-testid=workflow-node]')];
    expect(nodes.map(node => node.dataset.status)).toEqual(['done', 'running', 'waiting', 'waiting']);
    expect(nodes[1]!.querySelector('[data-testid=workflow-node-count]')?.textContent).toBe('1/3');

    nodes[1]!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-detail]')?.getAttribute('data-node-id')).toBe('review');
    const instances = document.querySelectorAll<HTMLButtonElement>('[data-testid=workflow-instance]');
    expect(instances).toHaveLength(3);
    instances[0]!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-output]')?.textContent).toContain('"bugs"');
    expect(store.delegationSelectedAgentId).toBe(store.workflowsOf('t-trace')[0]!.nodes[1]!.instances[0]!.threadId);

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-back]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-graph]')).not.toBeNull();
    expect(store.delegationSelectedAgentId).toBeNull();
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = ''; window.localStorage.clear();
  }
});

test('pausing hides the stop only once the run ends, and a saved plan runs again from the list', async () => {
  const client = new FakeClient({ delayMs: 0, delegationDemo: true });
  const store = new Store();
  store.attach(client);
  let component;
  try {
    await store.connect();
    await store.open('t-trace');
    await store.loadDelegation();
    const surface = store.panel.openWorkflow();
    component = mount(WorkflowSurface, { target: document.body, props: { store, surface, panel: store.panel } });
    await settle();

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-pause]')!.click();
    await settle();
    expect(document.querySelector('[data-testid=workflow-resume]')).not.toBeNull();
    expect(document.querySelector('[data-testid=workflow-stop]')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-template-save]')!.click();
    await settle();
    const name = document.querySelector<HTMLInputElement>('[data-testid=workflow-template-name]')!;
    expect(name.value).toBe('Review the parser');
    name.form!.requestSubmit();
    await settle();
    expect(document.querySelectorAll('[data-testid=workflow-template]')).toHaveLength(1);

    document.querySelector<HTMLButtonElement>('[data-testid=workflow-template-run]')!.click();
    await settle();
    expect(store.workflowsOf('t-trace')).toHaveLength(2);
    expect(store.panel.active?.runId).toBe(store.workflowsOf('t-trace').find(run => run.templateId !== null)!.id);
    expect(document.querySelector('[data-testid=workflow-runs]')).not.toBeNull();
  } finally {
    if (component) await unmount(component);
    store.detach(); client.close(); document.body.innerHTML = ''; window.localStorage.clear();
  }
});
