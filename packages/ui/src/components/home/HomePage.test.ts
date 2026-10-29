import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { RpcErrorCode } from '@boite/contracts';
import { confirm } from '../../lib/confirm.svelte';
import { setExperiment } from '../../lib/experiments';
import { inviteShare, readInvite } from '../../lib/contact-link';
import { contactsOf } from '../../lib/contacts.svelte';
import { FakeClient } from '../../lib/fake-client';
import { RpcFailure } from '../../lib/rpc-error';
import { FAKE_CONTACT_INVITE } from '../../lib/fake-client/contacts';
import { Store, store as primary } from '../../lib/store.svelte';
import { fill, strings } from '../../lib/strings';
import { workspace } from '../../lib/workspace.svelte';
import HomePage from './HomePage.svelte';
import SidebarContacts from './SidebarContacts.svelte';
import TitleBar from '../TitleBar.svelte';

let components: ReturnType<typeof mount>[] = [];
let opened: Store | undefined;

afterEach(async () => {
  confirm.answer(false);
  for (const component of components) await unmount(component);
  components = [];
  opened?.client?.close();
  opened?.detach();
  opened = undefined;
  workspace.machines = [];
  workspace.active = primary;
  document.body.innerHTML = '';
  setExperiment('contacts', false);
  localStorage.clear();
});

async function connect(): Promise<Store> {
  setExperiment('contacts', true);
  const store = new Store();
  store.machineId = 'home';
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  opened = store;
  workspace.machines = [{ id: 'home', label: 'Home', store }];
  workspace.active = store;
  return store;
}

/** The Contacts page as App draws it; `contact` opens that contact's page first. */
async function draw(contact: string | null = null): Promise<Store> {
  const store = await connect();
  store.showHome(contact);
  components.push(mount(HomePage, { target: document.body, props: { store } }));
  await vi.waitFor(() => { flushSync(); expect(one(contact ? `contact-${contact}` : 'home-add')).not.toBeNull(); });
  return store;
}

const one = <T extends HTMLElement>(testid: string) => document.querySelector<T>(`[data-testid="${testid}"]`);
const contacts = async (store: Store) => store.client!.call('contacts.get', {});

test('a contact request stays visible at the top in Settings and opens the machine that received it', async () => {
  const remote = await connect();
  const local = new Store();
  local.machineId = 'local';
  local.booted = true;
  local.page = 'settings';
  workspace.machines = [{ id: 'local', label: 'Local', store: local }, { id: 'home', label: 'Workstation', store: remote }];
  workspace.active = local;
  components.push(mount(TitleBar, { target: document.body, props: { store: local } }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-request-notice')).not.toBeNull(); });
  expect(one('contact-request-notice')!.textContent).toContain('Chris');
  expect(one('contact-request-notice')!.textContent).toContain('Workstation');
  one<HTMLButtonElement>('contact-request-review')!.click();
  await vi.waitFor(() => expect(workspace.active).toBe(remote));
  await vi.waitFor(() => expect([remote.page, remote.contact]).toEqual(['home', 'core-chris']));
  await remote.client!.call('contacts.decide', { id: 'creq-pending', accept: true, projectId: remote.projects[0]!.id });
  await vi.waitFor(() => { flushSync(); expect(one('contact-request-notice')).toBeNull(); });
});

test('a dismissed request keeps its header badge, which refreshes after a reconnect without an update', async () => {
  const store = await connect();
  store.page = 'settings';
  const client = store.client!;
  const call = client.call.bind(client);
  let decidedWhileOffline = false;
  vi.spyOn(client, 'call').mockImplementation((async (method, params) => {
    const value = await call(method, params);
    if (method !== 'contacts.get' || !decidedWhileOffline) return value;
    const state = value as Awaited<ReturnType<typeof contacts>>;
    return { ...state, requests: state.requests.filter(request => request.status !== 'pending') };
  }) as typeof client.call);
  components.push(mount(TitleBar, { target: document.body, props: { store } }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-request-notice')).not.toBeNull(); });
  one<HTMLButtonElement>('contact-request-dismiss')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-request-notice')).toBeNull(); });
  expect(one('contact-request-open')).not.toBeNull();
  store.connection = 'connecting';
  flushSync();
  decidedWhileOffline = true;
  store.connection = 'ready';
  flushSync();
  await vi.waitFor(() => { flushSync(); expect(one('contact-request-open')).toBeNull(); });
});

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('the list under the projects shows Chris and what he asks; a row opens his page, Add the page without one, and the fold is kept', async () => {
  const store = await connect();
  components.push(mount(SidebarContacts, { target: document.body, props: { store, machines: workspace.machines } }));
  await vi.waitFor(() => { flushSync(); expect(one('sidebar-contact')).not.toBeNull(); });
  const row = one<HTMLButtonElement>('sidebar-contact')!;
  expect([row.dataset.coreId, row.dataset.link]).toEqual(['core-chris', 'connected']);
  expect(row.textContent).toContain('Chris');
  expect(row.textContent).toContain('1');

  row.click();
  await vi.waitFor(() => expect([store.page, store.contact]).toEqual(['home', 'core-chris']));
  flushSync();
  expect(one('sidebar-contact')!.getAttribute('aria-current')).toBe('page');

  one<HTMLButtonElement>('sidebar-contacts-add')!.click();
  await vi.waitFor(() => expect([store.page, store.contact]).toEqual(['home', null]));

  // Folded, the title alone says something waits, and a second visit finds it folded.
  expect(one('sidebar-contacts-waiting')).toBeNull();
  one<HTMLButtonElement>('sidebar-contacts-toggle')!.click();
  flushSync();
  expect(one('sidebar-contacts-toggle')!.getAttribute('aria-expanded')).toBe('false');
  expect(one('sidebar-contacts-waiting')!.textContent).toBe('1');
  expect(localStorage.getItem('boite.contacts-folded')).toBe('1');
});

test('his page draws the link, both ways of sharing and the check words; rename, trust and read go to the core', async () => {
  const store = await draw('core-chris');
  expect(one('contact-link')!.textContent).toBe(strings.contacts.link.connected);
  expect(one('contact-shared')!.querySelector('[data-testid^="contact-grant-"]')?.textContent).toContain('boite');
  expect(one('contact-offer-chris-website')!.textContent).toContain('website');
  expect(one('contact-words')!.querySelectorAll('li')).toHaveLength(8);
  // Only what he asks shows on his page, and nothing of the page that adds a contact.
  expect(one('contact-requests')!.querySelector('[data-testid="contact-request-creq-pending"]')).not.toBeNull();
  expect(one('home-add')).toBeNull();

  one<HTMLButtonElement>('contact-name')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-name-input')).not.toBeNull(); });
  const field = one<HTMLInputElement>('contact-name-input')!;
  type(field, 'Chris B');
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-name')?.textContent).toContain('Chris B'); });

  one<HTMLInputElement>('contact-trusted')!.click();
  one<HTMLInputElement>('contact-read-p-boite')!.click();
  await vi.waitFor(async () => {
    const chris = (await contacts(store)).contacts[0]!;
    expect([chris.name, chris.trusted, chris.grants[0]!.readThreads]).toEqual(['Chris B', true, true]);
  });
});

test('a shared project shows its board as four counts that follow its cards; a click opens the board in its last conversation', async () => {
  const store = await draw('core-chris');
  const tallies = () => [...one('contact-board-p-boite')?.querySelectorAll('[data-column]') ?? []].map(node => node.textContent);
  // To do, In progress, In review, Done: one card open, one claimed, one confirmed.
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['1', '0', '1', '1']); });
  await store.client!.call('todos.add', { threadId: 't-trace', text: 'Show Chris the board' });
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['2', '0', '1', '1']); });

  one<HTMLButtonElement>('contact-board-p-boite')!.click();
  await vi.waitFor(() => expect([store.page, store.openThread?.projectId, store.boardShown]).toEqual(['chat', 'p-boite', true]));
});

test('the counts read again after a reconnect that may have missed an update, and after a first read that failed', async () => {
  setExperiment('contacts', true);
  const store = new Store();
  store.machineId = 'home';
  const client = new FakeClient({ delayMs: 0 });
  const call = client.call.bind(client);
  let refuse = true;
  vi.spyOn(client, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'todos.list' && refuse) { refuse = false; return Promise.reject(new Error('dropped')); }
    return call(method as never, params as never);
  }) as typeof client.call);
  store.attach(client);
  await store.connect();
  opened = store;
  workspace.machines = [{ id: 'home', label: 'Home', store }];
  workspace.active = store;
  store.showHome('core-chris');
  components.push(mount(HomePage, { target: document.body, props: { store } }));
  const tallies = () => [...one('contact-board-p-boite')?.querySelectorAll('[data-column]') ?? []].map(node => node.textContent);
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['0', '0', '0', '0']); });
  expect(refuse).toBe(false);

  const reconnect = async () => { store.connection = 'connecting'; flushSync(); store.connection = 'ready'; flushSync(); };
  await reconnect();
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['1', '0', '1', '1']); });

  // What the core holds moved while the link was down, and no update came.
  store.todos = { ...store.todos, 'p-boite': [] };
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['0', '0', '0', '0']); });
  await reconnect();
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['1', '0', '1', '1']); });
});

test("a board asked for from a contact's page stays hidden when another page is picked while its conversation opens", async () => {
  const store = await draw('core-chris');
  await vi.waitFor(() => { flushSync(); expect(one('contact-board-p-boite')).not.toBeNull(); });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const open = store.open.bind(store);
  vi.spyOn(store, 'open').mockImplementation(async (...args) => { const opening = open(...args); await gate; return opening; });

  one<HTMLButtonElement>('contact-board-p-boite')!.click();
  await vi.waitFor(() => expect(store.openThread?.projectId).toBe('p-boite'));
  store.showSettings();
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect([store.page, store.boardShown]).toEqual(['settings', false]);
});

test('accept shares the project picked in the menu; refuse waits for a reason; remove asks first and goes back to the page that adds one', async () => {
  const store = await draw();
  expect(one('home-waiting')).not.toBeNull();
  // The decided one is folded under its count, with who decided.
  expect(one<HTMLDetailsElement>('home-decided')!.open).toBe(false);
  expect(one('contact-request-creq-done')!.querySelector('[data-by="match"]')).not.toBeNull();

  one<HTMLButtonElement>('contact-refuse-creq-pending')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-refuse-reason')).not.toBeNull(); });
  expect(one<HTMLButtonElement>('contact-refuse-send')!.disabled).toBe(true);
  // Escape leaves the reason and gives Accept back.
  one('contact-refuse-reason')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  flushSync();
  one<HTMLButtonElement>('contact-accept-creq-pending')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-accept-creq-pending-menu')).not.toBeNull(); });
  one('contact-accept-creq-pending-menu')!.querySelector<HTMLButtonElement>('[data-value="p-notes"]')!.click();
  await vi.waitFor(async () => {
    const request = (await contacts(store)).requests.find(entry => entry.id === 'creq-pending')!;
    expect([request.status, request.project?.id]).toEqual(['accepted', 'p-notes']);
  });
  await vi.waitFor(() => { flushSync(); expect(one('home-waiting')).toBeNull(); });

  store.showHome('core-chris');
  await vi.waitFor(() => { flushSync(); expect(one('contact-remove')).not.toBeNull(); });
  one<HTMLButtonElement>('contact-remove')!.click();
  await vi.waitFor(() => expect(confirm.current?.danger).toBe(true));
  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(one('home-add')).not.toBeNull(); });
  expect(store.contact).toBeNull();
  expect((await contacts(store)).contacts).toEqual([]);
});

test('Elsewhere makes a link to this machine on Funnel, without a share; a tailnet outside tailscale.com invites only someone already on it', async () => {
  await draw();
  expect(one('contact-invite-self-hosted')).toBeNull();
  one<HTMLButtonElement>('contact-invite-internet')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-share')?.dataset.status).toBe('funnel'); });
  const link = readInvite(one<HTMLInputElement>('contact-invite-link')!.value)!;
  expect([link.u, link.s]).toEqual(['https://boite-pc.tail4f2a.ts.net:8443', null]);
  expect(one('contact-invite')!.textContent).toContain(strings.contacts.invite.funnel);
  // The core checked the link's origin from the internet: the owner knows it is ready to send.
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-reach')?.dataset.status).toBe('ready'); });
  expect(one('contact-invite-reach')!.textContent).toBe(strings.contacts.invite.reach.ready);
  for (const component of components.splice(0)) unmount(component);
  document.body.innerHTML = '';

  // Public DNS does not know the name yet: the owner is told to wait, then what to do once a repair did not help.
  const waiting = await connect();
  const waitingCall = waiting.client!.call.bind(waiting.client!);
  let repaired = false;
  let moved = false;
  vi.spyOn(waiting.client!, 'call').mockImplementation(((method: string, params: unknown) => method === 'contacts.get'
    ? waitingCall('contacts.get', {}).then(state => ({ ...state, funnel: state.funnel && (moved
      ? { ...state.funnel, url: state.funnel.url.replace(/:\d+$/, ':10000'), status: 'ready', repaired }
      : { ...state.funnel, status: 'unpublished', repaired }) }))
    : waitingCall(method as never, params as never)) as typeof waitingCall);
  waiting.showHome(null);
  components.push(mount(HomePage, { target: document.body, props: { store: waiting } }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-internet')).not.toBeNull(); });
  one<HTMLButtonElement>('contact-invite-internet')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-reach')?.dataset.status).toBe('unpublished'); });
  expect(one('contact-invite-reach')!.textContent).toContain(strings.contacts.invite.reach.unpublished);
  repaired = true;
  await contactsOf(waiting).refresh();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-reach')!.textContent).toContain(strings.contacts.invite.reach.stillUnpublished); });
  // A repair put Funnel on another port: the internet reaches it, but not at the port the link shown names.
  moved = true;
  await contactsOf(waiting).refresh();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-reach')?.dataset.status).toBe('moved'); });
  expect(one('contact-invite-reach')!.textContent).toContain(strings.contacts.invite.reach.moved);
  for (const component of components.splice(0)) unmount(component);
  document.body.innerHTML = '';

  // On Headscale neither a share nor Funnel reaches another network: the page says who invites whom.
  const store = await connect();
  const call = store.client!.call.bind(store.client!);
  vi.spyOn(store.client!, 'call').mockImplementation(((method: string, params: unknown) => method === 'contacts.get'
    ? call('contacts.get', {}).then(state => ({ ...state, tailscale: { ...state.tailscale, fqdn: 'boite.net.example.com' } }))
    : call(method as never, params as never)) as typeof call);
  store.showHome(null);
  components.push(mount(HomePage, { target: document.body, props: { store } }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-self-hosted')?.textContent).toBe(strings.contacts.invite.selfHosted); });
  expect(['contact-invite-tailnet', 'contact-invite-create', 'contact-invite-internet'].map(id => one<HTMLButtonElement>(id)!.disabled)).toEqual([false, true, true]);
  for (const component of components.splice(0)) unmount(component);
  document.body.innerHTML = '';

  // An older core reads only `share` and would share the machine: Elsewhere is not offered there.
  const older = await connect();
  const olderCall = older.client!.call.bind(older.client!);
  const sent: unknown[] = [];
  vi.spyOn(older.client!, 'call').mockImplementation(((method: string, params: unknown) => {
    if (method === 'contacts.invite') sent.push(params);
    return method === 'contacts.get' ? olderCall('contacts.get', {}).then(({ internet: _internet, ...state }) => state) : olderCall(method as never, params as never);
  }) as typeof olderCall);
  older.showHome(null);
  components.push(mount(HomePage, { target: document.body, props: { store: older } }));
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-create')).not.toBeNull(); });
  expect(one('contact-invite-internet')).toBeNull();
  expect(sent).toEqual([]);
});

test('a join retries an unpublished address despite a concurrent submission, and Stop ends it', async () => {
  const store = await draw();
  const call = store.client!.call.bind(store.client!);
  let refusals = 2;
  const joins = vi.fn();
  let finishFirst!: () => void;
  const firstJoin = new Promise<void>(resolve => { finishFirst = resolve; });
  vi.spyOn(store.client!, 'call').mockImplementation((async (method: string, params: unknown) => {
    if (method !== 'contacts.join') return call(method as never, params as never);
    joins();
    if (joins.mock.calls.length === 1) await firstJoin;
    if (refusals-- > 0) return Promise.reject(new RpcFailure({ code: RpcErrorCode.Unavailable, message: 'could not find NUNO: Tailscale has not published its address', data: { retryAfterMs: 150 } }));
    return call(method as never, params as never);
  }) as typeof call);
  type(one<HTMLInputElement>('contact-join-link')!, FAKE_CONTACT_INVITE);
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => expect(joins).toHaveBeenCalledTimes(1));
  // Another submission during the RPC must not cancel this join's retries.
  expect(await contactsOf(store).join(FAKE_CONTACT_INVITE)).toBeNull();
  expect(joins).toHaveBeenCalledTimes(1);
  finishFirst();
  await vi.waitFor(() => { flushSync(); expect(one('contact-join-waiting')).not.toBeNull(); });
  await vi.waitFor(() => { flushSync(); expect(one('contact-joined-words')?.querySelectorAll('li')).toHaveLength(8); });
  expect(joins).toHaveBeenCalledTimes(3);
  expect(one('contact-join-waiting')).toBeNull();
  one<HTMLButtonElement>('contact-joined-done')!.click();

  // Stop: no join goes again after it.
  refusals = Number.POSITIVE_INFINITY;
  joins.mockClear();
  await vi.waitFor(() => { flushSync(); expect(one('contact-join-link')).not.toBeNull(); });
  type(one<HTMLInputElement>('contact-join-link')!, FAKE_CONTACT_INVITE);
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-join-waiting')).not.toBeNull(); });
  one<HTMLButtonElement>('contact-join-stop')!.click();
  flushSync();
  expect(one('contact-join-waiting')).toBeNull();
  const made = joins.mock.calls.length;
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(joins).toHaveBeenCalledTimes(made);
});

test('Invite makes a link with its share; a joined link shows the eight words; Configure unfolds the key, the policy and the tier', async () => {
  const store = await draw();
  one<HTMLButtonElement>('contact-invite-create')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite')).not.toBeNull(); });
  const link = one<HTMLInputElement>('contact-invite-link')!.value;
  expect(link.startsWith('boite://contact#')).toBe(true);
  expect(one('contact-invite-share')!.dataset.status).toBe('created');
  expect(inviteShare(link)).not.toBeNull();

  // Someone already on this Tailscale: the link alone, no share made or asked for.
  one<HTMLButtonElement>('contact-invite-tailnet')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-share')!.dataset.status).toBe('none'); });
  const alone = one<HTMLInputElement>('contact-invite-link')!.value;
  expect([alone === link, inviteShare(alone)]).toEqual([false, null]);
  expect(one('contact-invite')!.textContent).not.toContain(strings.contacts.invite.manual);

  // A refused invitation copies nothing: the link on screen was made for someone else.
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  one<HTMLButtonElement>('contact-invite-create')!.click();
  await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  const shown = one<HTMLInputElement>('contact-invite-link')!.value;
  const call = store.client!.call.bind(store.client!);
  const refused = vi.spyOn(store.client!, 'call').mockImplementation(((method: string, params: unknown) =>
    method === 'contacts.invite' ? Promise.reject(new Error('at most 16 open invitations')) : call(method as never, params as never)) as typeof call);
  one<HTMLButtonElement>('contact-invite-tailnet')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('home-error')?.textContent).toContain('at most 16 open invitations'); });
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(one<HTMLInputElement>('contact-invite-link')!.value).toBe(shown);
  refused.mockRestore();
  delete (navigator as { clipboard?: unknown }).clipboard;
  one<HTMLButtonElement>('home-error')?.querySelector('button')?.click();

  // A link sent too widely: Cancel them spends every open invitation, the one shown included.
  await vi.waitFor(() => { flushSync(); expect(one('contact-invites-open')?.textContent).toContain(fill(strings.contacts.invite.open, { count: '3' })); });
  one<HTMLButtonElement>('contact-invites-cancel')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invites-open')).toBeNull(); });
  expect(one('contact-invite')).toBeNull();
  expect((await contacts(store)).invitations).toBe(0);

  // A core refuses its own link: the join takes another owner's.
  type(one<HTMLInputElement>('contact-join-link')!, FAKE_CONTACT_INVITE);
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-joined-words')?.querySelectorAll('li')).toHaveLength(8); });

  // The Tailscale row says the policy is open without unfolding anything.
  expect(one('contact-policy')!.dataset.policy).toBe('open');
  expect(one('contact-key-input')).toBeNull();
  one<HTMLButtonElement>('contact-configure')!.click();
  flushSync();
  expect(one('contact-policy-fix')).not.toBeNull();
  one<HTMLButtonElement>('contact-key-clear')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-policy')!.dataset.policy).toBe('unknown'); });
  expect(one('contact-key-state')!.textContent).toBe(strings.contacts.tailscale.keyMissing);
  expect(one('contact-policy-fix')).toBeNull();

  one<HTMLButtonElement>('home-tier-3')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('home-tier-3')!.getAttribute('aria-pressed')).toBe('true'); });
  expect((await contacts(store)).settings.minTier).toBe(3);
});

test('a link that shares the inviter, pasted without an API key, offers the share first and keeps it after a join that cannot reach', async () => {
  await draw();
  // Another owner's invitation, made while that owner's key was set, carries its Tailscale share.
  const link = FAKE_CONTACT_INVITE;
  const share = inviteShare(link);
  one<HTMLButtonElement>('contact-configure')!.click();
  flushSync();
  one<HTMLButtonElement>('contact-key-clear')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-key-state')!.textContent).toBe(strings.contacts.tailscale.keyMissing); });
  expect(one('contact-join-share')).toBeNull();

  type(one<HTMLInputElement>('contact-join-link')!, link);
  const step = one<HTMLAnchorElement>('contact-join-share')!;
  expect([step.href, step.target, step.textContent]).toEqual([share, '_blank', strings.contacts.join.acceptShare]);
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('home-error')?.textContent).toContain('accept its Tailscale share'); });
  expect(one('contact-join-share')).not.toBeNull();
  // Accepted meanwhile: the same link joins.
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-joined-words')?.querySelectorAll('li')).toHaveLength(8); });
  expect(one('contact-join-share')).toBeNull();
});
