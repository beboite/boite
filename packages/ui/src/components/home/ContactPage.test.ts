import { afterEach, expect, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import { test } from '../../test/fake-client';
import { contactsOf } from '../../lib/contacts.svelte';
import { confirm } from '../../lib/confirm.svelte';
import { workspace } from '../../lib/workspace.svelte';
import ContactPage from './ContactPage.svelte';

let component: Record<string, unknown> | undefined;
afterEach(async () => {
  if (component) await unmount(component, { outro: false });
  component = undefined;
  workspace.machines = [];
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});
async function settle() {
  for (let index = 0; index < 5; index++) { await tick(); await Promise.resolve(); }
  flushSync();
}
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!;

test('sharing searches projects across machines and keeps colliding grants, read access and revocation on their owner', async ({ ready }) => {
  const a = await ready({ delayMs: 0, coreId: 'machine-a' });
  const b = await ready({ delayMs: 0, coreId: 'machine-b' });
  const local = await a.client.call('projects.add', { path: '/local-app', name: 'Local app' });
  const remote = await b.client.call('projects.add', { path: '/builder-app', name: 'Builder app' });
  await b.client.call('contacts.update', { coreId: 'core-chris', name: 'Different nickname' });
  expect(remote.id).toBe(local.id);
  await a.client.call('contacts.grant', { coreId: 'core-chris', projectId: local.id });
  workspace.machines = [
    { id: 'a', label: 'Desktop', store: a.store },
    { id: 'b', label: 'Builder', store: b.store }
  ];
  workspace.active = a.store;
  const view = contactsOf(a.store);
  await view.refresh();
  const localCalls = vi.spyOn(a.client, 'call');
  const remoteCalls = vi.spyOn(b.client, 'call');
  component = mount(ContactPage, { target: document.body, props: { view, contact: view.state!.contacts[0]!, now: Date.now() } });
  await settle();
  button('[data-testid=contact-open-core-chris]').click();
  await settle();
  const search = document.querySelector<HTMLInputElement>('[data-testid=contact-open-core-chris-search]');
  expect(search, 'Share a project uses the searchable project and machine dropdown').not.toBeNull();
  search!.value = 'Builder app Builder';
  search!.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const options = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]'));
  expect(options.map(option => option.textContent)).toEqual([expect.stringContaining('Builder app')]);
  options[0]!.click();
  await settle();
  expect(remoteCalls).toHaveBeenCalledWith('contacts.grant', { coreId: 'core-chris', projectId: remote.id });
  expect(localCalls.mock.calls.filter(([method]) => method === 'contacts.grant')).toEqual([]);
  expect(workspace.active).toBe(a.store);
  expect(a.store.draft).toBeNull();
  const grants = Array.from(document.querySelectorAll<HTMLElement>('[data-testid^=contact-grant-]'));
  expect(grants.map(grant => grant.textContent)).toEqual(expect.arrayContaining([
    expect.stringContaining('Local app'), expect.stringContaining('Builder app')
  ]));
  const remoteGrant = grants.find(grant => grant.textContent?.includes('Builder app'))!;
  const read = remoteGrant.querySelector<HTMLInputElement>('input[role=switch]')!;
  read.checked = true;
  read.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(remoteCalls).toHaveBeenCalledWith('contacts.grant', { coreId: 'core-chris', projectId: remote.id, readThreads: true });
  vi.spyOn(confirm, 'ask').mockResolvedValue(true);
  remoteGrant.querySelector<HTMLButtonElement>(`[data-testid="contact-revoke-${remote.id}"]`)!.click();
  await settle();
  expect(remoteCalls).toHaveBeenCalledWith('contacts.revoke', { coreId: 'core-chris', projectId: remote.id });
  expect(localCalls.mock.calls.filter(([method]) => method === 'contacts.revoke')).toEqual([]);
  expect((await a.client.call('contacts.get', {})).contacts[0]!.grants.some(grant => grant.projectId === local.id)).toBe(true);
  // A failure on the target must reach the page that initiated the share.
  remoteCalls.mockRejectedValueOnce(new Error('Remote share failed'));
  button('[data-testid=contact-open-core-chris]').click();
  await settle();
  const retry = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(option => option.textContent?.includes('Builder app'))!;
  retry.click();
  await settle();
  expect(view.error).toBe('Remote share failed');
});

test('sharing excludes offline machines, paired devices and machines without this contact', async ({ ready }) => {
  const a = await ready({ delayMs: 0, coreId: 'machine-a' });
  const unlinked = await ready({ delayMs: 0, coreId: 'unlinked' });
  const offline = await ready({ delayMs: 0, coreId: 'offline' });
  const paired = await ready({ delayMs: 0, coreId: 'paired' });
  await unlinked.client.call('contacts.remove', { coreId: 'core-chris' });
  offline.store.connection = 'closed';
  vi.spyOn(paired.store, 'owner', 'get').mockReturnValue(false);
  workspace.machines = [
    { id: 'a', label: 'Desktop', store: a.store },
    { id: 'unlinked', label: 'Unlinked', store: unlinked.store },
    { id: 'offline', label: 'Offline', store: offline.store },
    { id: 'paired', label: 'Paired', store: paired.store }
  ];
  const view = contactsOf(a.store);
  await view.refresh();
  component = mount(ContactPage, { target: document.body, props: { view, contact: view.state!.contacts[0]!, now: Date.now() } });
  await settle();
  button('[data-testid=contact-open-core-chris]').click();
  await settle();
  const menu = document.querySelector<HTMLElement>('[data-testid=contact-open-core-chris-menu]')!;
  expect(menu.textContent).toContain('Desktop');
  for (const label of ['Unlinked', 'Offline', 'Paired', 'Drafts', 'Work in a folder']) expect(menu.textContent).not.toContain(label);
  expect(Array.from(menu.querySelectorAll<HTMLElement>('[role=option]')).map(option => JSON.parse(option.dataset['value']!)[0])).toEqual(['a']);
  // Reconnection and unlinking update an open picker, so a stale remote row cannot grant access.
  offline.store.connection = 'ready';
  await settle();
  expect(menu.textContent).toContain('Offline');
  await offline.client.call('contacts.remove', { coreId: 'core-chris' });
  await settle();
  expect(menu.textContent).not.toContain('Offline');
});

test('a machine of the linked machine\'s group shares its projects through it, without the contact linked there', async ({ ready }) => {
  const a = await ready({ delayMs: 0, coreId: 'machine-a' });
  const b = await ready({ delayMs: 0, coreId: 'machine-b' });
  const remote = await b.client.call('projects.add', { path: '/builder-app', name: 'Builder app' });
  const account = (await b.client.call('accounts.list', {}))[0]!;
  const source = await b.client.call('threads.create', {projectId: remote.id, providerId: account.providerId, accountId: account.id, title: 'Member source'});
  await b.client.call('contacts.remove', { coreId: 'core-chris' });
  await a.client.call('group.create', { name: 'Home' });
  await b.client.call('group.join', { invite: (await a.client.call('group.invite', {})).invite });
  await Promise.all([a.store.loadGroup(), b.store.loadGroup()]);
  workspace.machines = [
    { id: 'a', label: 'Desktop', store: a.store },
    { id: 'b', label: 'Builder', store: b.store }
  ];
  workspace.active = a.store;
  const view = contactsOf(a.store);
  await view.refresh();
  const linkedCalls = vi.spyOn(a.client, 'call');
  const memberCalls = vi.spyOn(b.client, 'call');
  component = mount(ContactPage, { target: document.body, props: { view, contact: view.state!.contacts[0]!, now: Date.now() } });
  await settle();
  button('[data-testid=contact-open-core-chris]').click();
  await settle();
  const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role=option]')).find(row => row.textContent?.includes('Builder app'));
  expect(option, 'the member\'s projects are offered although the contact is linked to the other machine only').toBeDefined();
  option!.click();
  await settle();
  // The machine the contact is linked to is asked, naming the member that holds the project.
  expect(linkedCalls).toHaveBeenCalledWith('contacts.grant', { coreId: 'core-chris', projectId: remote.id, machine: 'machine-b' });
  expect(memberCalls.mock.calls.filter(([method]) => method === 'contacts.grant')).toEqual([]);
  expect(memberCalls).toHaveBeenCalledWith('sharedProjects.list', {threadId: source.id});
  const row = document.querySelector<HTMLElement>(`[data-testid="contact-grant-${remote.id}"]`)!;
  expect(row.dataset['machineId']).toBe('b');
  expect(row.textContent).toContain('Builder app');
  expect(row.textContent).toContain('Builder');
  const read = row.querySelector<HTMLInputElement>('input[role=switch]')!;
  read.checked = true;
  read.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  expect(linkedCalls).toHaveBeenCalledWith('contacts.grant', { coreId: 'core-chris', projectId: remote.id, readThreads: true, machine: 'machine-b' });
  vi.spyOn(confirm, 'ask').mockResolvedValue(true);
  row.querySelector<HTMLButtonElement>(`[data-testid="contact-revoke-${remote.id}"]`)!.click();
  await settle();
  expect(linkedCalls).toHaveBeenCalledWith('contacts.revoke', { coreId: 'core-chris', projectId: remote.id, machine: 'machine-b' });
  expect((await a.client.call('contacts.get', {})).contacts[0]!.grants.some(grant => grant.machine === 'machine-b')).toBe(false);
});
