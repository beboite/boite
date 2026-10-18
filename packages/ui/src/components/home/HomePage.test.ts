import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { confirm } from '../../lib/confirm.svelte';
import { FakeClient } from '../../lib/fake-client';
import { Store, store as primary } from '../../lib/store.svelte';
import { strings } from '../../lib/strings';
import { workspace } from '../../lib/workspace.svelte';
import HomePage from './HomePage.svelte';

let component: ReturnType<typeof mount> | undefined;
let opened: Store | undefined;

afterEach(async () => {
  confirm.answer(false);
  if (component) await unmount(component);
  opened?.client?.close();
  opened?.detach();
  opened = undefined;
  workspace.machines = [];
  workspace.active = primary;
  component = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
});

async function draw(): Promise<Store> {
  localStorage.setItem('boite.experiments', JSON.stringify(['contacts']));
  const store = new Store();
  store.machineId = 'home';
  store.attach(new FakeClient({ delayMs: 0 }));
  await store.connect();
  opened = store;
  workspace.machines = [{ id: 'home', label: 'Home', store }];
  workspace.active = store;
  component = mount(HomePage, { target: document.body, props: { store } });
  await vi.waitFor(() => { flushSync(); expect(one('contact-core-chris')).not.toBeNull(); });
  return store;
}

const one = <T extends HTMLElement>(testid: string) => document.querySelector<T>(`[data-testid="${testid}"]`);
const contacts = async (store: Store) => store.client!.call('contacts.get', {});

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

test('Chris is drawn with the link, both lanes and the waiting request; rename, trust and read go to the core', async () => {
  const store = await draw();
  const card = one('contact-core-chris')!;
  expect(one('contact-link')!.textContent).toBe(strings.contacts.link.connected);
  expect(card.querySelector('[data-testid^="contact-grant-"]')?.textContent).toContain('boite');
  expect(one('contact-offer-chris-website')!.textContent).toContain('website');
  expect(one('contact-words')!.querySelectorAll('li')).toHaveLength(4);
  expect(one('home-waiting')).not.toBeNull();
  expect(one('contact-request-creq-pending')).not.toBeNull();
  // The decided one is folded under its count, with who decided.
  expect(one<HTMLDetailsElement>('home-decided')!.open).toBe(false);
  expect(one('contact-request-creq-done')!.querySelector('[data-by="match"]')).not.toBeNull();

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

test('accept opens the project picked in the menu; refuse waits for a reason; remove asks first', async () => {
  const store = await draw();
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

  one<HTMLButtonElement>('contact-remove')!.click();
  await vi.waitFor(() => expect(confirm.current?.danger).toBe(true));
  confirm.answer(true);
  await vi.waitFor(() => { flushSync(); expect(one('home-no-contact')).not.toBeNull(); });
  expect((await contacts(store)).contacts).toEqual([]);
});

test('an invitation shows its link and share; a joined link shows the four words; the key clears and the tier moves', async () => {
  const store = await draw();
  one<HTMLButtonElement>('contact-invite-create')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite')).not.toBeNull(); });
  const link = one<HTMLInputElement>('contact-invite-link')!.value;
  expect(link.startsWith('boite://contact#')).toBe(true);
  expect(one('contact-invite-share')!.dataset.status).toBe('created');

  type(one<HTMLInputElement>('contact-join-link')!, link);
  one<HTMLButtonElement>('contact-join')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-joined-words')?.querySelectorAll('li')).toHaveLength(4); });

  expect(one('contact-policy')!.dataset.policy).toBe('open');
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
  // Made while the key is set, the invitation carries its Tailscale share.
  one<HTMLButtonElement>('contact-invite-create')!.click();
  await vi.waitFor(() => { flushSync(); expect(one('contact-invite-share')?.dataset.status).toBe('created'); });
  const link = one<HTMLInputElement>('contact-invite-link')!.value;
  const share = one<HTMLAnchorElement>('contact-invite-share')!.href;
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
  await vi.waitFor(() => { flushSync(); expect(one('contact-joined-words')?.querySelectorAll('li')).toHaveLength(4); });
  expect(one('contact-join-share')).toBeNull();
});
