import { afterEach, expect, test, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import AgentDock from './AgentDock.svelte';

let component: ReturnType<typeof mount> | undefined;
let store: Store;
let client: FakeClient;
afterEach(async () => {
  if (component) await unmount(component, { outro: false });
  store?.detach();
  client?.close();
  document.body.innerHTML = '';
});

test('a workflow without active children shows a timer and opens the team overview', async () => {
  client = new FakeClient({ delayMs: 0, delegationDemo: true });
  store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-native');
  const [run] = await client.call('workflows.list', { threadId: 't-trace' });
  component = mount(AgentDock, { target: document.body, props: { store, threadId: 't-native' } });
  await vi.waitFor(() => expect(store.workflowsThreadId).toBe('t-native'));
  await tick();
  expect(document.querySelector('[data-testid=agent-dock]')).toBeNull();

  store.workflows = [{ ...run!, rootThreadId: 't-native', status: 'running', createdAt: Date.now() - 62_000, nodes: [] }];
  await tick();
  const button = document.querySelector<HTMLButtonElement>('[data-testid=agent-dock] button');
  expect(button?.textContent).toContain('1 workflow');
  expect(button?.querySelector('[data-testid=agent-elapsed]')?.textContent).toContain('1 m');
  const surface = store.panel.openWorkflow(run!.id);
  store.panel.close(surface.id);
  button!.click();
  await tick();
  expect(store.panel.isOpen).toBe(true);
  expect(store.panel.active?.kind).toBe('agents');
  expect(store.panel.active?.runId).toBeUndefined();

  store.workflows[0]!.status = 'done';
  await tick();
  expect(document.querySelector('[data-testid=agent-dock]')).toBeNull();
});
