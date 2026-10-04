import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { confirm } from '../lib/confirm.svelte';
import { FakeClient } from '../lib/fake-client';
import { Store, store as primary } from '../lib/store.svelte';
import { strings } from '../lib/strings';
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

/** Presses "Invite a machine" and has a second fake core join with what the card shows. */
async function joined(): Promise<Store> {
  one<HTMLButtonElement>('group-invite')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('group-invite-code')).not.toBeNull(); });
  const second = await machine('second', 'Second');
  expect(await second.joinGroup(one<HTMLInputElement>('group-invite-code')!.value)).toBe(true);
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-first', 'core-second']); });
  return second;
}

test('an owner with no group creates one and sees itself as the only member', async () => {
  const first = await machine('first', 'First');
  draw(first);
  await settle();
  expect(one('group-card')!.textContent).toContain(strings.group.heading);
  expect(one('group-join-input')).not.toBeNull();
  const create = one<HTMLButtonElement>('group-create')!;
  expect(create.disabled).toBe(true);

  type('group-name', 'Home');
  expect(create.disabled).toBe(false);
  create.click();
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-first']); });
  expect(one('group-card')!.querySelector('h2')!.textContent).toContain('Home');
  expect(one('group-member')!.textContent).toContain(strings.group.self);
  expect(one('group-member-remove')).toBeNull();
  expect(one('group-name')).toBeNull();
});

test('inviting shows an invitation, and the machine that joins with it becomes a member', async () => {
  const first = await grouped();
  expect(one('group-invite-code')).toBeNull();
  await joined();
  expect(first.group?.cores.map((core) => core.name)).toEqual(['First', 'Second']);
  expect(document.querySelector('[data-core-id="core-second"]')!.textContent).toContain('Second');
  // It was for one machine: used, it leaves the card.
  await vi.waitFor(() => { flushSync(); expect(one('group-invite-code')).toBeNull(); });
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

test('a member says how it is reached, and one switch keeps every connected one like the selected machine', async () => {
  await grouped();
  const second = await joined();
  const row = () => document.querySelector('[data-core-id="core-second"]')!.textContent;
  // Not a machine of this window yet: nothing to copy to, and the row says why once the links know.
  expect(one('group-sync')).toBeNull();
  workspace.groups.states = { 'core-second': 'unreachable' };
  await vi.waitFor(() => { flushSync(); expect(row()).toContain(strings.group.unreachable); });
  workspace.groups.states = {};

  workspace.machines = [...workspace.machines, { id: 'second', label: 'Second', store: second }];
  await vi.waitFor(() => { flushSync(); expect(row()).toContain(strings.group.connected); });
  const [source, target] = workspace.machines;
  const box = one<HTMLInputElement>('group-sync')!;
  expect(box.checked).toBe(false);
  box.click();
  flushSync();
  expect(workspace.settingsSync.source(target!)).toBe(source);
  expect(box.checked).toBe(true);
  box.click();
  flushSync();
  expect(workspace.settingsSync.enabled(target!)).toBe(false);
  workspace.groups.states = {};
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

test('leaving asks first, then returns to the two forms', async () => {
  const first = await grouped();
  one<HTMLButtonElement>('group-leave')!.click();
  await settle();
  expect(confirm.current?.title).toContain('Home');
  expect(first.group).not.toBeNull();

  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(one('group-name')).not.toBeNull(); });
  expect(one('group-join')).not.toBeNull();
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

  // The core the phone is paired with joins as its owner would; the phone only reads the roster.
  expect(await host.createGroup('Home')).toBe(true);
  await host.inviteToGroup();
  const client = phone.client as FakeClient;
  client.becomes('owner');
  await client.call('group.join', { invite: host.groupInvite!.invite });
  client.becomes('session');
  await vi.waitFor(() => { flushSync(); expect(members()).toEqual(['core-phone', 'core-first']); });
  expect(phone.owner).toBe(false);
  for (const control of ['group-invite', 'group-member-remove', 'group-leave', 'group-sync', 'group-invite-code']) {
    expect(one(control), control).toBeNull();
  }
});
