import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { workspace, type Machine } from '../lib/workspace.svelte';
import { fill, strings } from '../lib/strings';
import { closedFailure } from '../lib/rpc-error';
import { confirm } from '../lib/confirm.svelte';
import MachinesPage from './MachinesPage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
let stop: (() => void) | undefined;
const stores: Store[] = [];
afterEach(async () => {
  confirm.answer(false);
  if (mounted) await unmount(mounted);
  mounted = undefined;
  stop?.(); stop = undefined;
  for (const store of stores.splice(0)) { store.client?.close(); store.detach(); }
  workspace.machines = [];
  workspace.active = primary;
  workspace.settingsSync.reports = {};
  document.body.innerHTML = '';
  localStorage.clear();
});

async function setup(separate = false) {
  const machines: Machine[] = [];
  for (const id of ['source', 'target']) {
    const store = new Store();
    store.attach(new FakeClient({ delayMs: 0, coreId: id, coreName: id, publicUrl: `https://${id}.test` }));
    await store.connect();
    stores.push(store);
    machines.push({ id, label: id, store });
  }
  workspace.machines = machines;
  workspace.active = machines[0]!.store;
  if (separate) {
    await machines[0]!.store.createGroup('Home');
    await machines[1]!.store.createGroup('Office');
  }
  stop = workspace.settingsSync.start();
  mounted = mount(MachinesPage, { target: document.body, props: { mobile: true } });
  await vi.waitFor(() => { flushSync(); expect(machines[0]!.store.group?.cores).toHaveLength(separate ? 1 : 2); });
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

test('the default machine is one choice for the whole group: the others follow it, the window stays where it was', async () => {
  // A copy an earlier version kept for this window alone: the choice in the group replaces it.
  localStorage.setItem('boite.settings-sync', JSON.stringify({ target: 'source' }));
  const { source, target } = await setup();
  expect(query('[data-testid="machines-page"] h1').textContent).toContain(strings.settings.tabs.machines);
  // Nothing to unfold: each machine is one row, its details on the settings pages the bar above them picks.
  expect(document.querySelectorAll('[data-testid="machine-card"]')).toHaveLength(2);
  expect(document.querySelector('[data-testid="machine-details-toggle"], [data-testid="machine-updates-card"], [data-testid="machine-settings-open"]')).toBeNull();
  await source.store.open('t-trace');
  const thread = source.store.openThread;
  await source.store.client!.call('settings.set', { asyncQuestions: false, warmProcessMinutes: 9, agentMemoryBudgetPercent: 70 });
  await target.store.client!.call('settings.set', { warmProcessMinutes: 2, agentMemoryBudgetPercent: 40 });
  expect(query('[data-testid="group-home-pick"]').textContent).toContain(strings.machines.homeNone);

  query<HTMLButtonElement>('[data-testid="group-home-pick"]').click();
  flushSync();
  query<HTMLElement>('[data-testid="group-home-pick-menu"] [data-value="source"]').click();
  // Every member reports the same choice: it lives in the group, not in this window.
  await vi.waitFor(() => expect([source.store.group?.settingsHome, target.store.group?.settingsHome]).toEqual(['source', 'source']));
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(false));
  flushSync();
  expect(query('[data-machine-id="source"] [data-testid="machine-home"]').textContent).toBe(strings.machines.homeBadge);
  expect(document.querySelector('[data-machine-id="target"] [data-testid="machine-home"]')).toBeNull();
  expect(query('[data-testid="group-home-pick"]').textContent).toContain('source');
  // What belongs to each machine stays there.
  expect(target.store.settings).toMatchObject({ warmProcessMinutes: 2, agentMemoryBudgetPercent: 40 });
  expect(localStorage.getItem('boite.settings-sync')).toBeNull();
  await source.store.client!.call('settings.set', { asyncQuestions: true });
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(true));
  expect(workspace.active).toBe(source.store);
  expect(source.store.openThread).toBe(thread);

  query<HTMLButtonElement>('[data-testid="group-home-pick"]').click();
  flushSync();
  query<HTMLElement>(`[data-testid="group-home-pick-menu"] [data-value="none"]`).click();
  await vi.waitFor(() => expect(target.store.group?.settingsHome).toBeUndefined());
  flushSync();
  expect(document.querySelector('[data-testid="machine-home"]')).toBeNull();
  await source.store.client!.call('settings.set', { asyncQuestions: false });
  await new Promise(resolve => setTimeout(resolve, 250));
  expect(target.store.settings?.asyncQuestions).toBe(true);
});

test('this computer goes by its own name and "(you)", whatever it was called by default', async () => {
  const { source } = await setup();
  source.store.localCore = true;
  source.store.core = { ...source.store.core!, hostname: 'NUNO-X870' };
  workspace.customize(source.id, strings.machines.local, source.icon);
  flushSync();
  const name = query<HTMLInputElement>('[data-machine-id="source"] [data-testid="machine-rename"]');
  expect(name.value).toBe('NUNO-X870');
  expect(query('[data-machine-id="source"] [data-testid="machine-you"]').textContent).toBe(strings.machines.youTag);
  expect(document.querySelector('[data-machine-id="target"] [data-testid="machine-you"]')).toBeNull();
  // Renamed, it keeps the name it was given.
  name.value = 'Desk';
  name.dispatchEvent(new Event('change', { bubbles: true }));
  flushSync();
  expect(query<HTMLInputElement>('[data-machine-id="source"] [data-testid="machine-rename"]').value).toBe('Desk');
});

test('a phone can wear a phone icon, and the choice is saved', async () => {
  const { target } = await setup();
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-customize"]').click();
  flushSync();
  const phone = query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-icon-phone"]');
  expect(phone.title).toBe(strings.machines.icons.phone);
  phone.click();
  flushSync();
  expect(phone.getAttribute('aria-pressed')).toBe('true');
  expect(workspace.machines.find(machine => machine.id === target.id)?.icon).toBe('phone');
  const saved = Object.keys(localStorage).map(key => localStorage.getItem(key)).join('\n');
  expect(saved).toContain('"icon":"phone"');
});

test('each row says where its updates stand and one button checks every machine', async () => {
  const { source, target } = await setup();
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="machine-updates-state"]')).toHaveLength(2); });
  const settled = (machine: Machine) => machine.store.harnessUpdates.map(update => ({ ...update, latest: update.current, pending: false, skipped: null, state: 'idle' as const, checkedAt: 1 }));
  source.store.harnessUpdates = settled(source);
  target.store.harnessUpdates = settled(target).map((update, index) => index === 0 ? { ...update, current: '1.0.0', latest: '99.0.0', pending: true } : update);
  flushSync();
  const said = (id: string) => query(`[data-machine-id="${id}"] [data-testid="machine-updates-state"]`);
  expect([said('target').dataset.state, said('target').textContent]).toEqual(['available', strings.harnessUpdates.availableShort]);
  expect([said('source').dataset.state, said('source').textContent]).toEqual(['current', strings.serverUpdate.current]);

  const checks = [source, target].map(machine => vi.spyOn(machine.store, 'loadHarnessUpdates').mockResolvedValue());
  const server = vi.spyOn(target.store.serverUpdater, 'load').mockResolvedValue();
  query<HTMLButtonElement>('[data-testid="updates-check-all"]').click();
  await vi.waitFor(() => expect(checks.map(check => check.mock.calls)).toEqual([[[true]], [[true]]]));
  expect(server).toHaveBeenCalledWith(true);

});

test('a machine that does not answer is grey and offers only its name, its icon and its removal', async () => {
  const { target } = await setup();
  const card = () => query('[data-machine-id="target"]');
  const has = (id: string) => card().querySelector(`[data-testid="${id}"]`) !== null;
  expect([has('machine-open'), has('machine-remove'), card().dataset.away]).toEqual([true, true, undefined]);
  // The screenshot's case: the first attempt timed out and the client keeps retrying behind the card.
  target.store.threads = target.store.threads.map(thread => ({ ...thread, status: 'idle' }));
  target.store.connection = 'connecting';
  target.store.booted = true;
  target.store.error = 'connection did not answer within 10 seconds';
  flushSync();
  expect(card().dataset.away).toBe('offline');
  expect(query('[data-machine-id="target"] [data-testid="machine-card-status"]').textContent).toBe(strings.connection.offline);
  expect([has('machine-open'), has('machine-rename'), has('machine-customize'), has('machine-remove')]).toEqual([false, true, true, true]);
  expect(card().querySelector('.error')).toBeNull();
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-remove"]').click();
  await vi.waitFor(() => expect(confirm.current?.title).toContain(target.label));
  confirm.answer(false);
  // A machine with a turn still running when it went away stays a warning, with its error.
  target.store.threads = target.store.threads.map((thread, index) => index === 0 ? { ...thread, status: 'running' } : thread);
  flushSync();
  expect([card().dataset.away, card().querySelector('.error')?.textContent]).toEqual(['lost', 'connection did not answer within 10 seconds']);
  expect([has('machine-open'), has('machine-remove')]).toEqual([false, true]);
  // A call that found it away only repeats "Offline": the card stays quiet, and anywhere else it names the machine.
  target.store.reportError(closedFailure());
  flushSync();
  expect([card().dataset.away, card().querySelector('.error'), target.store.error]).toEqual(['lost', null, target.store.core?.hostname ? fill(strings.errors.notConnected, { machine: target.store.core.hostname }) : strings.errors.notConnectedHere]);
  // Back online, the card is whole again without a click.
  target.store.connection = 'ready';
  flushSync();
  expect([has('machine-open'), has('machine-remove'), card().dataset.away]).toEqual([true, true, undefined]);
});

test('a thread that failed on a machine reads as that thread, and its button opens it', async () => {
  const { target } = await setup();
  const thread = target.store.threads[0]!;
  (target.store.client as FakeClient).emitCoreLog('error', 'turn failed: the context refilled to the limit', { threadId: thread.id });
  await vi.waitFor(() => { flushSync(); expect(query('[data-machine-id="target"] [data-testid="machine-thread-failed"] p').textContent).toBe(fill(strings.machines.threadFailed, { thread: thread.title })); });
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-thread-failed-open"]').click();
  await vi.waitFor(() => expect([workspace.active, target.store.openThread?.id]).toEqual([target.store, thread.id]));
  flushSync();
  expect([target.store.error, document.querySelector('[data-testid="machine-thread-failed"]')]).toEqual([null, null]);
});

test('removing a connected row removes the group member and keeps the current conversation on its owner', async () => {
  const { source, target } = await setup();
  await source.store.open('t-trace');
  const thread = source.store.openThread;
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-remove"]').click();
  await vi.waitFor(() => expect(confirm.current?.title).toContain(target.label));
  confirm.answer(true);
  await vi.waitFor(() => expect(workspace.machines).toHaveLength(1));
  expect((await source.store.client!.call('group.get', {}))?.cores.map(core => core.coreId)).toEqual(['source']);
  expect(workspace.active).toBe(source.store);
  expect(source.store.openThread).toBe(thread);
});

test('existing separate groups keep their own actions and removing their row leaves the correct group', async () => {
  const { source, target } = await setup(true);
  const cards = document.querySelectorAll<HTMLElement>('[data-testid="group-card"]');
  expect(cards).toHaveLength(2);
  const office = [...cards].find(card => card.querySelector('[data-testid="group-rename-start"]')?.textContent === 'Office')!;
  expect(office.querySelector('[data-machine-id="target"]')).not.toBeNull();
  office.querySelector<HTMLButtonElement>('[data-testid="group-rename-start"]')!.click();
  flushSync();
  input('[data-testid="group-rename"]', 'Work');
  query('[data-testid="group-rename"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => expect(target.store.group?.name).toBe('Work'));
  expect(source.store.group?.name).toBe('Home');
  query<HTMLButtonElement>('[data-machine-id="target"] [data-testid="machine-remove"]').click();
  await vi.waitFor(() => expect(confirm.current).not.toBeNull());
  confirm.answer(true);
  await vi.waitFor(() => expect(workspace.machines).toHaveLength(1));
  expect(target.store.group).toBeNull();
  expect(source.store.group?.name).toBe('Home');
});

test('a link minted on another machine of the group, by the Tailscale switch on its Advanced page, is the one the group card shows', async () => {
  const { target } = await setup();
  expect(document.querySelector('[data-testid="add-device"]')).toBeNull();
  target.store.deviceInvite = { url: 'https://target.tail.ts.net/?grant=g#join=j', expiresAt: Date.now() + 60_000 };
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(query('[data-testid="add-device"]').dataset.link).toBe('https://target.tail.ts.net/?grant=g#join=j'); });
});

test('each machine says for itself whether the others may start threads on it, and the default machine does not copy it', async () => {
  const { source, target } = await setup();
  await source.store.client!.call('group.settingsHome', { coreId: 'source' });
  await vi.waitFor(() => expect(target.store.group?.settingsHome).toBe('source'));
  await vi.waitFor(() => { flushSync(); expect(document.querySelectorAll('[data-testid="machine-group-threads-switch"]')).toHaveLength(2); });
  const switches = [...document.querySelectorAll<HTMLInputElement>('[data-testid="machine-group-threads-switch"]')];
  expect(switches.map(toggle => toggle.checked)).toEqual([false, false]);
  expect(query('[data-testid="machine-group-threads"]').textContent).toContain(strings.machines.groupThreads);

  // The default machine, the one the others copy, accepts them: the machine that follows it keeps its own answer.
  query<HTMLInputElement>('[data-machine-id="source"] [data-testid="machine-group-threads-switch"]').click();
  await vi.waitFor(() => expect(source.store.settings?.groupThreads).toBe(true));
  await source.store.client!.call('settings.set', { asyncQuestions: false });
  await vi.waitFor(() => expect(target.store.settings?.asyncQuestions).toBe(false));
  expect(target.store.settings?.groupThreads ?? false).toBe(false);
  expect(target.store.settings?.syncOverrides ?? []).not.toContain('groupThreads');
  // Its own switch changes that machine alone.
  query<HTMLInputElement>('[data-machine-id="target"] [data-testid="machine-group-threads-switch"]').click();
  await vi.waitFor(() => expect(target.store.settings?.groupThreads).toBe(true));
  await target.store.saveSettings({ groupThreads: false });
  expect([source.store.settings?.groupThreads, target.store.settings?.groupThreads]).toEqual([true, false]);
});
