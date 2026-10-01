import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace, type Machine } from '../lib/workspace.svelte';
import { strings } from '../lib/strings';
import MachinesPage from './MachinesPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let stop: (() => void) | undefined;
const stores: Store[] = [];
afterEach(async () => {
  if (mounted) await unmount(mounted);
  mounted = undefined;
  stop?.(); stop = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  workspace.settingsSync.links = {};
  workspace.settingsSync.reports = {};
  document.body.innerHTML = '';
  localStorage.clear();
});

async function setup() {
  const machines: Machine[] = [];
  for (const id of ['source', 'target']) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0 }));
    await store.connect();
    stores.push(store);
    machines.push({ id, label: id, store });
  }
  workspace.machines = machines;
  workspace.active = machines[0]!.store;
  stop = workspace.settingsSync.start();
  mounted = mount(MachinesPage, { target: document.body, props: { mobile: true } });
  flushSync();
  return { source: machines[0]!, target: machines[1]! };
}

function query<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`missing ${selector}`);
  return element;
}
function input(selector: string, value: string) {
  const field = query<HTMLInputElement>(selector);
  field.value = value;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('sync stays on the list and the settings button edits the owning machine without changing the active conversation', async () => {
  const { source, target } = await setup();
  await source.store.open('t-trace');
  const thread = source.store.openThread;
  await source.store.client!.call('settings.set', { asyncQuestions: false, warmProcessMinutes: 9, agentMemoryBudgetPercent: 70 });
  await target.store.client!.call('settings.set', { warmProcessMinutes: 2, agentMemoryBudgetPercent: 40 });
  query<HTMLInputElement>('[data-machine-id="target"] [data-testid="machine-sync"]').click();
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(false));
  await vi.waitFor(() => expect(workspace.settingsSync.reports[target.id]).toBeDefined());
  flushSync();
  expect(document.querySelector('[data-testid="machine-sync-report"]')).toBeNull();
  expect(document.querySelector('[data-testid="machine-settings"]')).toBeNull();
  expect(target.store.settings).toMatchObject({ warmProcessMinutes: 2, agentMemoryBudgetPercent: 40 });

  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-settings-open"]').click();
  flushSync();
  expect(query('[data-testid="machine-settings"]').dataset.machineId).toBe('target');
  expect(query('[data-testid="machine-settings-source"]').textContent).toContain('source');
  expect(query<HTMLInputElement>('[data-testid="memory-budget"]').value).toBe('40');
  expect(document.querySelector('[data-testid="setting-focus-guard"]')).toBeNull();
  input('[data-testid="memory-budget"]', '50');
  query('[data-testid="memory-budget"]').closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await vi.waitFor(() => expect(target.store.settings?.agentMemoryBudgetPercent).toBe(50));
  expect(source.store.settings?.agentMemoryBudgetPercent).toBe(70);

  input('[data-testid="setting-warmProcessMinutes"]', '12');
  query<HTMLButtonElement>('[data-testid="scheduler-save"]').click();
  await vi.waitFor(() => expect(target.store.settings?.warmProcessMinutes).toBe(12));
  expect(source.store.settings?.warmProcessMinutes).toBe(9);
  query<HTMLInputElement>('[data-testid="setting-auto-update-harnesses"]').click();
  await vi.waitFor(() => expect(target.store.settings?.autoUpdateHarnesses).toBe(true));
  expect(source.store.settings?.autoUpdateHarnesses).toBe(false);
  expect(document.querySelector('[data-testid="worktree-storage"]')).not.toBeNull();
  await source.store.client!.call('settings.set', { asyncQuestions: true });
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(true));
  expect(target.store.settings).toMatchObject({ warmProcessMinutes: 12, agentMemoryBudgetPercent: 50, autoUpdateHarnesses: true });
  expect(workspace.active).toBe(source.store);
  expect(source.store.openThread).toBe(thread);

  query<HTMLButtonElement>('[data-testid="machine-settings-back"]').click();
  flushSync();
  expect(query<HTMLInputElement>('[data-machine-id="target"] [data-testid="machine-sync"]').checked).toBe(true);
  expect(workspace.active).toBe(source.store);
});

test('offline and paired machines cannot be edited and a removed target never falls back to the active machine', async () => {
  const { source, target } = await setup();
  target.store.principal = 'session';
  flushSync();
  expect(document.querySelector('[data-machine-id="target"] [data-testid="machine-settings-open"]')).toBeNull();
  target.store.principal = 'owner';
  target.store.connection = 'closed';
  flushSync();
  expect(query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-settings-open"]').disabled).toBe(true);
  target.store.connection = 'ready';
  flushSync();
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-settings-open"]').click();
  flushSync();
  target.store.connection = 'closed';
  flushSync();
  expect(query<HTMLFieldSetElement>('[data-testid="machine-settings"] > fieldset').disabled).toBe(true);
  workspace.machines = workspace.machines.filter(machine => machine.id !== target.id);
  flushSync();
  expect(document.querySelector('[data-testid="machine-settings"]')).toBeNull();
  expect(workspace.active).toBe(source.store);
});

test.each([
  { name: 'missing keybindings', patch: { keybindings: null }, message: strings.machines.syncKeysAbsent },
  { name: 'missing brain', patch: { brain: 'absent' as const }, message: strings.machines.syncBrainAbsent },
  { name: 'provider sign-ins', patch: { providers: [{ id: 'codex', name: 'Codex', members: [] }] }, message: 'Codex' }
])('sync still reports $name without repeating the checkbox label', async ({ patch, message }) => {
  const { source, target } = await setup();
  workspace.settingsSync.reports[target.id] = {
    source: source.label,
    report: { settings: target.store.settings!, changed: 0, keybindings: target.store.keybindings!, brain: 'none', providers: [], ...patch }
  };
  flushSync();
  const report = query('[data-testid="machine-sync-report"]');
  expect(report.textContent).toContain(message);
  expect(report.querySelectorAll('p')).toHaveLength(1);
  expect(!!report.querySelector('[data-testid="machine-sync-providers"]')).toBe('providers' in patch);
});
