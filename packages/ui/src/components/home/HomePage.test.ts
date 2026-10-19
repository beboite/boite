import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { confirm } from '../../lib/confirm.svelte';
import { setExperiment } from '../../lib/experiments';
import { inviteShare } from '../../lib/contact-link';
import { FakeClient } from '../../lib/fake-client';
import { FAKE_CONTACT_INVITE } from '../../lib/fake-client/contacts';
import { Store, store as primary } from '../../lib/store.svelte';
import { strings } from '../../lib/strings';
import { workspace } from '../../lib/workspace.svelte';
import HomePage from './HomePage.svelte';
import SidebarContacts from './SidebarContacts.svelte';

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
  setExperiment('goal2', false);
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
  // The board is a `/goal2` experiment: off, a shared project shows none.
  expect(one('contact-board-p-boite')).toBeNull();
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
  setExperiment('goal2', true);
  const store = await draw('core-chris');
  const tallies = () => [...one('contact-board-p-boite')?.querySelectorAll('[data-column]') ?? []].map(node => node.textContent);
  // To do, In progress, In review, Done: one card open, one claimed, one confirmed.
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['1', '0', '1', '1']); });
  await store.client!.call('todos.add', { threadId: 't-trace', text: 'Show Chris the board' });
  await vi.waitFor(() => { flushSync(); expect(tallies()).toEqual(['2', '0', '1', '1']); });

  one<HTMLButtonElement>('contact-board-p-boite')!.click();
  await vi.waitFor(() => expect([store.page, store.openThread?.projectId, store.boardShown]).toEqual(['chat', 'p-boite', true]));
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

test('Invite makes a link with its share; a joined link shows the eight words; Configure unfolds the key, the policy and the tier', async () => {
  const store = await draw();
  one<HTMLButtonElement>('contact-invite-create')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite')).not.toBeNull(); });
  const link = one<HTMLInputElement>('contact-invite-link')!.value;
  expect(link.startsWith('boite://contact#')).toBe(true);
  expect(one('contact-invite-share')!.dataset.status).toBe('created');

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
