import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { STEWARD_DEFAULT_CAPABILITIES } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import CoordinationPanel from './CoordinationPanel.svelte';

let component: ReturnType<typeof mount> | undefined;
let store: Store | undefined;
const settle = async () => { for (let index = 0; index < 20; index += 1) { await Promise.resolve(); flushSync(); } };
const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const toggle = async (selector: string) => { $<HTMLInputElement>(selector)!.click(); await settle(); };

afterEach(async () => {
  if (component) await unmount(component);
  store?.client?.close();
  store?.detach();
  component = undefined;
  store = undefined;
  document.body.innerHTML = '';
});

async function show(client: FakeClient): Promise<Store> {
  store = new Store();
  store.attach(client);
  await store.connect();
  await store.open('t-trace');
  component = mount(CoordinationPanel, { target: document.body, props: { store, threadId: 't-trace', expanded: true } });
  await settle();
  return store;
}

test('an owner makes the agent a steward of its own project, then picks projects, capabilities and notices', async () => {
  const owner = await show(new FakeClient({ delayMs: 0 }));
  expect(owner.stewards).toEqual([]);
  expect($('[data-testid="steward-chip"]')).toBeNull();
  expect($('[data-testid="steward-projects"]')).toBeNull();

  await toggle('[data-testid="steward-enabled"]');
  expect(owner.stewards).toMatchObject([{ threadId: 't-trace', projectIds: ['p-boite'], allProjects: false, capabilities: [...STEWARD_DEFAULT_CAPABILITIES], notify: true }]);
  expect($('[data-testid="steward-chip"]')?.textContent).toBe('Steward · 1 project');
  const projects = [...document.querySelectorAll<HTMLInputElement>('[data-testid="steward-project"]')];
  expect(projects.map(input => [input.dataset.projectId, input.checked, input.disabled])).toEqual([['p-boite', true, true], ['p-notes', false, false]]);
  const capabilities = [...document.querySelectorAll<HTMLInputElement>('[data-testid="steward-capability"]')];
  expect(capabilities.filter(input => !input.checked).map(input => input.dataset.capability)).toEqual(['permissions', 'remove']);
  expect([...document.querySelectorAll('[data-testid="steward-risky"]')].map(tag => tag.closest('li')?.querySelector('input')?.dataset.capability)).toEqual(['permissions', 'remove']);

  await toggle('[data-testid="steward-project"][data-project-id="p-notes"]');
  expect(owner.stewards?.[0]?.projectIds).toEqual(['p-boite', 'p-notes']);
  expect($('[data-testid="steward-chip"]')?.textContent).toBe('Steward · 2 projects');
  await toggle('[data-testid="steward-capability"][data-capability="permissions"]');
  await toggle('[data-testid="steward-capability"][data-capability="spawn"]');
  expect(owner.stewards?.[0]?.capabilities).toEqual(['message', 'archive', 'move', 'stop', 'answer', 'permissions']);
  await toggle('[data-testid="steward-notify"]');
  expect(owner.stewards?.[0]?.notify).toBe(false);
  await toggle('[data-testid="steward-all"]');
  expect(owner.stewards?.[0]).toMatchObject({ allProjects: true, projectIds: [] });
  expect($('[data-testid="steward-projects"]')).toBeNull();
  expect($('[data-testid="steward-chip"]')?.textContent).toBe('Steward · all projects');

  await toggle('[data-testid="steward-enabled"]');
  expect(owner.stewards).toEqual([]);
  expect($('[data-testid="steward-capabilities"]')).toBeNull();
});

test('a paired device sees the grant but cannot change it', async () => {
  const client = new FakeClient({ delayMs: 0, stewardDemo: true, principal: 'session' });
  const device = await show(client);
  const steward = device.stewards?.[0];
  expect(steward?.threadId).toBeDefined();
  // The demo grant sits on the newest thread of the first project; read the one the panel shows.
  if (steward!.threadId !== 't-trace') {
    await unmount(component!);
    await device.open(steward!.threadId);
    component = mount(CoordinationPanel, { target: document.body, props: { store: device, threadId: steward!.threadId, expanded: true } });
    await settle();
  }
  expect($('[data-testid="steward-owner-only"]')).not.toBeNull();
  const inputs = [...document.querySelectorAll<HTMLInputElement>('[data-testid="steward-settings"] input')];
  expect(inputs.length).toBeGreaterThan(8);
  expect(inputs.every(input => input.disabled)).toBe(true);
  expect($<HTMLInputElement>('[data-testid="steward-enabled"]')?.checked).toBe(true);
  inputs[0]!.click();
  await settle();
  expect(device.stewards).toEqual([steward]);
});

test('a read that succeeds after a failed one clears the error it left', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const owner = await show(client);
  const call = client.call.bind(client);
  let fail = true;
  client.call = ((method: string, params: unknown) => method === 'stewards.list' && fail ? Promise.reject(new Error('core busy')) : call(method as never, params as never)) as typeof client.call;
  await owner.loadStewards();
  expect(owner.stewardsError).toBe('core busy');
  fail = false;
  await owner.loadStewards();
  expect(owner.stewardsError).toBeNull();
});
