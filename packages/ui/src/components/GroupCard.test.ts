import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { confirm } from '../lib/confirm.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { fill, strings } from '../lib/strings';
import { workspace } from '../lib/workspace.svelte';
import GroupCard from './GroupCard.svelte';

let component: ReturnType<typeof mount> | undefined;
const opened: Store[] = [];
const settle = async () => { for (let index = 0; index < 30; index += 1) { await Promise.resolve(); flushSync(); } };

afterEach(async () => {
  confirm.answer(false);
  if (component) await unmount(component);
  for (const target of opened) { target.client?.close(); target.detach(); }
  opened.length = 0;
  workspace.machines = [];
  workspace.active = primary;
  component = undefined;
  document.body.innerHTML = '';
});

async function machine(id: string, name: string, principal: 'owner' | 'session' = 'owner'): Promise<Store> {
  const target = new Store();
  target.machineId = id;
  target.attach(new FakeClient({ delayMs: 0, principal, coreId: `core-${id}`, coreName: name, publicUrl: `https://${id}.test` }));
  await target.connect();
  opened.push(target);
  return target;
}

function draw(store: Store) {
  workspace.machines = [{ id: store.machineId ?? 'first', label: 'First', store }];
  workspace.active = store;
  component = mount(GroupCard, { target: document.body, props: { store } });
}

const one = <T extends HTMLElement>(testid: string) => document.querySelector<T>(`[data-testid="${testid}"]`);
const members = () => [...document.querySelectorAll<HTMLElement>('[data-testid="group-member"]')].map((row) => row.dataset.coreId);

function type(testid: string, value: string) {
  const input = one<HTMLInputElement>(testid)!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

/** An owner in a group it just created, with the card drawn. */
async function grouped(): Promise<Store> {
  const first = await machine('first', 'First');
  expect(await first.createGroup('Home')).toBe(true);
  draw(first);
  await settle();
  return first;
}

/** Presses "Add a device" and has a second fake core paste the link under Join, as a computer does. */
async function joined(existing?: Store): Promise<Store> {
  const first = workspace.active;
  one<HTMLButtonElement>('group-add-device')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('add-device')).not.toBeNull(); });
  const second = existing ?? await machine('second', 'Second');
  expect(await second.joinGroup(first.deviceInvite!.url)).toBe(true);
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-first', 'core-second']); });
  return second;
}

test('a core older than Add a device says to update it instead of failing once pressed', async () => {
  const first = await machine('first', 'First');
  // A core from before Add a device says no `deviceKeys` at hello.
  first.core!.features = { ...first.core!.features, deviceKeys: false };
  draw(first);
  await settle();
  const call = vi.spyOn(first.client!, 'call');
  expect(one<HTMLButtonElement>('group-add-device')!.disabled).toBe(true);
  expect(one('group-add-older')!.textContent).toBe(fill(strings.group.addOlder, { machine: first.core!.hostname ?? strings.machines.local }));
  one<HTMLButtonElement>('group-add-device')!.click();
  await settle();
  expect(call).not.toHaveBeenCalledWith('group.addDevice', expect.anything());
  expect(first.error).toBeNull();
});

/** A phone admitted by the fake core under its owner's key, as the real one does when the phone opens its link. */
async function enroll(target: Store, publicKey: string): Promise<string> {
  const { id } = await target.client!.call('group.enrollDevice', { publicKey, name: 'phone', at: Date.now(), sig: 'fake-signature' });
  return id;
}

test('an owner with no group gets Add a device and Join; adding a device starts a group of its own', async () => {
  const first = await machine('first', 'First');
  draw(first);
  await settle();
  expect(one('group-card')!.textContent).toContain(strings.group.heading);
  expect(members()).toEqual([]);
  expect(one('group-join-input')).not.toBeNull();
  expect(one<HTMLButtonElement>('group-join')!.disabled).toBe(true);
  expect(one('add-device')).toBeNull();

  one<HTMLButtonElement>('group-add-device')!.click();
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-first']); });
  expect(first.group?.cores.map((core) => core.coreId)).toEqual(['core-first']);
  expect(one('group-member')!.textContent).toContain(strings.group.self);
  expect(one('group-member-remove')).toBeNull();
  // Alone in the group it just started: it may still join another, and has nothing to leave.
  expect(one('group-join-input')).not.toBeNull();
  expect(one('group-leave')).toBeNull();
});

test('Add a device shows one QR code and no code to type, closes, and a machine that joins with the link spends it', async () => {
  const first = await grouped();
  one<HTMLButtonElement>('group-add-device')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('add-device-qr')?.querySelector('svg')).toBeTruthy(); });
  expect(one('add-device-code')).toBeNull();
  expect(one('add-device')!.textContent).toContain(strings.group.scanTitle);
  expect(one('lan-reach')).toBeNull();
  one<HTMLButtonElement>('add-device-close')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('add-device')).toBeNull(); });
  expect(first.deviceInvite).toBeNull();

  // The machine that joins brings the phones it had added.
  const second = await machine('second', 'Second');
  const carried = await enroll(second, 'carried-phone-key');
  await joined(second);
  expect(first.group?.cores.map((core) => core.name)).toEqual(['First', 'Second']);
  expect(document.querySelector('[data-core-id="core-second"]')!.textContent).toContain('Second');
  // It was for one device: used, it leaves the card.
  await vi.waitFor(() => { flushSync(); expect(one('add-device')).toBeNull(); });
  expect(first.deviceInvite).toBeNull();
  // A machine with company has no Join, and may leave.
  expect(one('group-join-input')).toBeNull();
  expect(one('group-leave')).not.toBeNull();
  await vi.waitFor(() => { flushSync(); expect([...document.querySelectorAll<HTMLElement>('[data-testid="group-device"]')].map((row) => row.dataset.deviceId)).toEqual([carried]); });
});

test('clicking the group name edits it, Enter shares the rename, and Escape cancels', async () => {
  const first = await grouped();
  const second = await joined();
  one<HTMLButtonElement>('group-rename-start')!.click();
  await settle();
  expect(document.activeElement).toBe(one('group-rename'));
  type('group-rename', 'Studio');
  one('group-rename')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.waitFor(() => { flushSync(); expect(first.group?.name).toBe('Studio'); expect(second.group?.name).toBe('Studio'); });
  expect(one('group-rename')).toBeNull();
  one<HTMLButtonElement>('group-rename-start')!.click();
  await settle();
  type('group-rename', 'Cancelled');
  one('group-rename')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await settle();
  expect(first.group?.name).toBe('Studio');
  expect(one('group-rename')).toBeNull();
  one<HTMLButtonElement>('group-rename-start')!.click();
  await settle();
  type('group-rename', 'Office');
  one('group-rename')!.dispatchEvent(new FocusEvent('blur'));
  await vi.waitFor(() => { flushSync(); expect(second.group?.name).toBe('Office'); });
});

test('a member says how it is reached, and the default machine is picked once for every member, an older one named', async () => {
  const first = await grouped();
  const second = await joined();
  const row = () => document.querySelector('[data-core-id="core-second"]')!.textContent;
  workspace.groups.states = { 'core-second': 'unreachable' };
  await vi.waitFor(() => { flushSync(); expect(row()).toContain(strings.group.unreachable); });
  workspace.groups.states = {};
  workspace.machines = [...workspace.machines, { id: 'second', label: 'Second', store: second }];
  await vi.waitFor(() => { flushSync(); expect(row()).toContain(strings.group.connected); });

  // Nothing chosen: each machine keeps its own, and the picker says so.
  expect(one('group-home-pick')!.textContent).toContain(strings.machines.homeNone);
  one<HTMLButtonElement>('group-home-pick')!.click();
  flushSync();
  const options = [...document.querySelectorAll<HTMLElement>('[data-testid="group-home-pick-menu"] [data-value]')].map((item) => item.dataset.value);
  expect(options).toEqual(['none', 'core-first', 'core-second']);
  document.querySelector<HTMLElement>('[data-testid="group-home-pick-menu"] [data-value="core-second"]')!.click();
  await vi.waitFor(() => { flushSync(); expect([first.group?.settingsHome, second.group?.settingsHome]).toEqual(['core-second', 'core-second']); });
  expect(one('group-home-pick')!.textContent).toContain('Second');
  expect(one('group-home-older')).toBeNull();

  // A member whose Boite predates the choice is named: it keeps its own settings until updated.
  second.core = { ...second.core!, features: { ...second.core!.features, settingsHome: false } };
  flushSync();
  expect(one('group-home-older')!.textContent).toContain('Second');
});

test('removing a member asks first, then takes it off the list', async () => {
  await grouped();
  const second = await joined();
  one<HTMLButtonElement>('group-member-remove')!.click();
  await settle();
  expect(confirm.current?.title).toContain('Second');
  expect(confirm.current?.danger).toBe(true);
  expect(members()).toEqual(['core-first', 'core-second']);

  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-first']); });
  await vi.waitFor(() => expect(second.group).toBeNull());
});

test('a device is listed after the machines, says where it was added, and removing it asks first', async () => {
  const first = await grouped();
  const id = await enroll(first, 'listed-phone-key');
  await vi.waitFor(() => { flushSync(); expect(one('group-device')).not.toBeNull(); });
  const rows = [...document.querySelectorAll<HTMLElement>('[data-testid="group-member"], [data-testid="group-device"]')];
  expect(rows.map((row) => row.dataset.testid)).toEqual(['group-member', 'group-device']);
  expect(one('group-device')!.dataset.deviceId).toBe(id);
  expect(one('group-device')!.textContent).toContain(strings.group.phone);
  // The name this window gives the machine that added it.
  expect(one('group-device')!.textContent).toContain(fill(strings.group.deviceAdded, { machine: 'First' }));

  one<HTMLButtonElement>('group-device-remove')!.click();
  await settle();
  expect(confirm.current?.title).toBe(fill(strings.group.revokeDeviceTitle, { device: strings.group.phone }));
  expect(confirm.current?.danger).toBe(true);
  confirm.answer(false);
  await settle();
  expect(first.group?.devices.map((device) => device.id)).toEqual([id]);

  one<HTMLButtonElement>('group-device-remove')!.click();
  await settle();
  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(one('group-device')).toBeNull(); });
  expect(first.group?.devices).toEqual([]);
});

test('leaving asks first, then returns to Add a device and Join', async () => {
  const first = await grouped();
  // Alone in its group, a machine has nothing to leave.
  expect(one('group-leave')).toBeNull();
  await joined();
  one<HTMLButtonElement>('group-leave')!.click();
  await settle();
  expect(confirm.current?.title).toContain('Home');
  expect(first.group).not.toBeNull();

  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(one('group-join')).not.toBeNull(); });
  expect(one('group-add-device')).not.toBeNull();
  expect(members()).toEqual([]);
  expect(first.group).toBeNull();
});

test('a paired device sees nothing without a group, and only the members in one', async () => {
  const host = await machine('first', 'First');
  const phone = await machine('phone', 'Phone', 'session');
  draw(phone);
  await settle();
  expect(phone.owner).toBe(false);
  // Nothing drawn: no element, only the anchors Svelte leaves for its blocks.
  expect(document.body.childElementCount).toBe(0);
  expect(document.body.textContent?.trim()).toBe('');

  // The core the phone is paired with joins as its owner would, with the link Add a device gives; the phone only reads the roster.
  expect(await host.createGroup('Home')).toBe(true);
  await host.addDevice();
  await enroll(host, 'other-phone-key');
  const client = phone.client as FakeClient;
  client.becomes('owner');
  await client.call('group.join', { invite: host.deviceInvite!.url });
  client.becomes('session');
  // Read again as the phone: the read the join set off may have answered as the owner.
  await phone.loadGroup();
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-phone', 'core-first']); });
  expect(phone.group?.devices).toEqual([]);
  expect(phone.owner).toBe(false);
  for (const control of ['group-add-device', 'add-device', 'group-member-remove', 'group-device', 'group-device-remove', 'group-leave', 'group-sync', 'group-join-input', 'group-rename-start']) {
    expect(one(control), control).toBeNull();
  }
});
