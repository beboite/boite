import { afterEach, expect, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync, mount, tick, unmount } from 'svelte';
import { open as nativeOpen } from '@tauri-apps/plugin-dialog';
import ProjectPicker from './ProjectPicker.svelte';
import type { FakeClient, FakeClientOptions } from '../lib/fake-client';
import type { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
let component: Record<string, unknown> | undefined;
afterEach(async () => {
  if (component) await unmount(component, { outro: false });
  component = undefined;
  workspace.machines = [];
  delete window.__TAURI_INTERNALS__;
  document.body.innerHTML = ''; localStorage.clear(); vi.restoreAllMocks();
});
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function settle() { for (let index = 0; index < 5; index++) { await tick(); await Promise.resolve(); } flushSync(); }
async function draw(createStore: (options?: FakeClientOptions) => { store: Store; client: FakeClient }) {
  const { store: a, client: ca } = createStore(), { store: b, client: cb } = createStore({ delayMs: 0, coreId: 'machine-b' });
  a.machineId = 'machine-a'; b.machineId = 'machine-b'; a.attach(ca); b.attach(cb);
  await Promise.all([a.connect(), b.connect()]);
  await cb.call('projects.add', { path: '/B-collision' });
  workspace.machines = [{ id: 'machine-a', label: 'Machine A', store: a }, { id: 'machine-b', label: 'Machine B', store: b }]; workspace.active = a;
  a.projectPickerOpen = true;
  component = mount(ProjectPicker, { target: document.body, props: { store: a } }); await settle();
  return { a, b, ca, cb };
}

test.for(['machine', 'cancel-reopen'])('a delayed project Add keeps its owning machine and respects %s intent', async (intent, { createStore }) => {
  const { a, b, ca } = await draw(createStore);
  const call = ca.call.bind(ca), started = deferred<void>(), released = deferred<void>();
  const spy = vi.spyOn(ca, 'call').mockImplementation(async (method, params) => {
    const result = await call(method, params);
    if (method === 'projects.add') { started.resolve(); await released.promise; }
    return result;
  });
  const input = document.querySelector<HTMLInputElement>('[data-testid=project-path]')!;
  input.value = '/A-project'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=project-add]')!.click(); await started.promise;
  if (intent === 'machine') {
    document.querySelector<HTMLButtonElement>('[data-testid=project-machine]')!.click(); await settle();
    document.querySelector<HTMLButtonElement>('[data-value=machine-b]')!.click(); await settle();
  } else { document.querySelector<HTMLButtonElement>('[data-testid=project-cancel]')!.click(); await settle(); a.projectPickerOpen = true; await settle(); }
  released.resolve(); await settle();
  expect(workspace.active).toBe(a); expect(a.projectPickerOpen).toBe(true);
  expect(b.projects.find(project => project.id === 'p-101')?.path).toBe('/B-collision');
  expect(b.draft?.projectId).not.toBe('p-101');
  expect(spy.mock.calls.filter(([method]) => method === 'projects.add')).toHaveLength(1);
  expect(a.projects.find(project => project.id === 'p-101')?.path).toBe('/A-project');
});

test('cancel and reopen invalidates a pending native folder picker before project creation', async ({ createStore }) => {
  window.__TAURI_INTERNALS__ = {} as never;
  const { a, ca } = await draw(createStore); a.localCore = true; await settle();
  const released = deferred<string>(); vi.mocked(nativeOpen).mockReturnValue(released.promise);
  const spy = vi.spyOn(ca, 'call');
  document.querySelector<HTMLButtonElement>('[data-testid=pick-project]')!.click(); await vi.waitFor(() => expect(nativeOpen).toHaveBeenCalledOnce());
  document.querySelector<HTMLButtonElement>('[data-testid=project-cancel]')!.click(); await settle(); a.projectPickerOpen = true; await settle();
  released.resolve('/A-native'); await settle();
  expect(a.projectPickerOpen).toBe(true); expect(spy.mock.calls.filter(([method]) => method === 'projects.add')).toHaveLength(0);
});
