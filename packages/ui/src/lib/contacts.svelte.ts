/*
 * The Home page's state for one machine: its contacts, their requests, the
 * contact settings and the Tailscale side, read with `contacts.get` and read
 * again on `contacts.updated`. The Contacts page, lists and request notice
 * load it with the Contacts experiment.
 */

import type { Contact, ContactInvite, ContactRequest, ContactSettings, ContactsState, ContactTailscale, ProjectId } from '@boite/contracts';
import { untrack } from 'svelte';
import { errorText } from './errors';
import { RpcFailure } from './rpc-error';
import { strings } from './strings';
import type { Store } from './store.svelte';
import { workspace, type Machine } from './workspace.svelte';

/** What `isBusy` names while a grant changes: the project, on the machine that holds it. */
export function grantKey(coreId: string, projectId: ProjectId, machine?: string): string {
  return machine ? `grant:${coreId}:${machine}:${projectId}` : `grant:${coreId}:${projectId}`;
}

export class ContactsView {
  state = $state<ContactsState | null>(null);
  /** The last call that failed, in words; cleared by the next one that succeeds. */
  error = $state('');
  /** The first read failed: the page has nothing to show but this and Retry. */
  loadError = $state('');
  /** The invitation made on this visit, shown until another replaces it. */
  invite = $state<ContactInvite | null>(null);
  /** What `contacts.join` answered: the four words stay on screen until the owner closes them. */
  joined = $state<Contact | null>(null);
  /** A join waiting for the inviter's address to reach the internet, until `until`. */
  joinWaiting = $state<{ until: number } | null>(null);
  /** Keys of the calls in flight, so a button does not send twice. */
  busy = $state<string[]>([]);

  readonly store: Store;
  #watchers = 0;
  #release: (() => void) | null = null;
  #client: unknown = null;
  #ready = false;
  #reading = 0;
  #joinAttempt = 0;

  constructor(store: Store) {
    this.store = store;
  }

  /** Reads the state and follows `contacts.updated` while the page is drawn. Returns the release. */
  watch(): () => void {
    this.#watchers += 1;
    this.follow();
    return () => {
      this.#watchers -= 1;
      if (this.#watchers > 0) return;
      this.#release?.();
      this.#release = null;
      this.#client = null;
      this.#ready = false;
      this.#reading += 1;
    };
  }

  /** A socket can reconnect on the same client: read again after either one changes. */
  follow(): void {
    const client = this.store.client;
    const ready = this.store.connection === 'ready';
    if (this.#watchers === 0 || (client === this.#client && ready === this.#ready)) return;
    this.#release?.();
    this.#client = client;
    this.#ready = ready;
    this.#reading += 1;
    this.#release = client ? client.on('contacts.updated', () => { void this.refresh(); }) : null;
    if (ready) void this.refresh();
  }

  async refresh(): Promise<void> {
    const read = ++this.#reading;
    const client = this.store.client;
    if (!client || this.store.connection !== 'ready') return;
    try {
      const state = await client.call('contacts.get', {});
      // An older read that lands after a newer one must not put back what changed since.
      if (read !== this.#reading || client !== this.store.client) return;
      this.state = state;
      this.loadError = '';
    } catch (error) {
      if (read === this.#reading && !this.state) this.loadError = errorText(error);
    }
  }

  isBusy(key: string): boolean {
    return this.busy.includes(key);
  }

  /** One call under `key`: its error lands in `error`, its result in the caller. Null when it failed or was already running. */
  async #run<T>(key: string, call: () => Promise<T>): Promise<T | null> {
    if (this.busy.includes(key)) return null;
    this.busy = [...this.busy, key];
    try {
      const result = await call();
      this.error = '';
      return result;
    } catch (error) {
      this.error = errorText(error);
      return null;
    } finally {
      this.busy = this.busy.filter(entry => entry !== key);
    }
  }

  #connected(): NonNullable<Store['client']> {
    const client = this.store.client;
    if (!client) throw new Error('This machine is disconnected.');
    return client;
  }

  /** Puts a contact the core answered with in place, before the event's read lands. */
  #put(contact: Contact): void {
    if (!this.state) return;
    const at = this.state.contacts.findIndex(entry => entry.coreId === contact.coreId);
    this.state.contacts = at < 0 ? [...this.state.contacts, contact] : this.state.contacts.map(entry => entry.coreId === contact.coreId ? contact : entry);
  }

  async rename(coreId: string, name: string): Promise<void> {
    const contact = await this.#run(`update:${coreId}`, () => this.#connected().call('contacts.update', { coreId, name }));
    if (contact) this.#put(contact);
  }

  async trust(coreId: string, trusted: boolean): Promise<void> {
    const contact = await this.#run(`update:${coreId}`, () => this.#connected().call('contacts.update', { coreId, trusted }));
    if (contact) this.#put(contact);
  }

  /** `machine`: the core id of the group member that holds the project, when it is not this machine's. */
  async grant(coreId: string, projectId: ProjectId, readThreads?: boolean, machine?: string): Promise<void> {
    const contact = await this.#run(grantKey(coreId, projectId, machine), () => this.#connected().call('contacts.grant', { coreId, projectId, ...(readThreads === undefined ? {} : { readThreads }), ...(machine ? { machine } : {}) }));
    if (contact) this.#put(contact);
  }

  async revoke(coreId: string, projectId: ProjectId, machine?: string): Promise<void> {
    const contact = await this.#run(grantKey(coreId, projectId, machine), () => this.#connected().call('contacts.revoke', { coreId, projectId, ...(machine ? { machine } : {}) }));
    if (contact) this.#put(contact);
  }

  async remove(coreId: string): Promise<void> {
    const done = await this.#run(`remove:${coreId}`, () => this.#connected().call('contacts.remove', { coreId }));
    if (done && this.state) this.state.contacts = this.state.contacts.filter(entry => entry.coreId !== coreId);
  }

  async decide(id: string, decision: { accept: true; projectId: ProjectId } | { accept: false; reason: string }): Promise<ContactRequest | null> {
    const request = await this.#run(`decide:${id}`, () => this.#connected().call('contacts.decide', { id, ...decision }));
    if (request && this.state) this.state.requests = this.state.requests.map(entry => entry.id === id ? request : entry);
    return request;
  }

  /** Delivers a held contact letter to its thread, or refuses it. True once the core took the decision. */
  async decideMail(id: string, accept: boolean): Promise<boolean> {
    const done = await this.#run(`mail:${id}`, () => this.#connected().call('contacts.decideMail', { id, accept }));
    if (done && this.state?.mail) this.state.mail = this.state.mail.filter(entry => entry.id !== id);
    return done !== null;
  }

  async settings(settings: ContactSettings): Promise<void> {
    const next = await this.#run('settings', () => this.#connected().call('contacts.settings', { settings }));
    if (next && this.state) this.state.settings = next;
  }

  async tailscaleKey(key: string | null): Promise<ContactTailscale | null> {
    const next = await this.#run('tailscale-key', () => this.#connected().call('contacts.tailscaleKey', { key }));
    if (next && this.state) this.state.tailscale = next;
    return next;
  }

  /**
   * `tailnet`: the invitee already reaches this machine on Tailscale, so the
   * link alone does. `share`: the link also shares this machine with another
   * tailscale.com tailnet. `internet`: the invitee is on another network and
   * the link reaches this machine through Tailscale Funnel. True once this
   * call made the invitation now shown.
   */
  async createInvite(reach: InviteReach = 'share'): Promise<boolean> {
    const params = reach === 'internet' ? { internet: true } : { share: reach === 'share' };
    const invite = await this.#run('invite', async () => {
      // An older core would answer `internet` with a share of this machine: never sent there.
      if (reach === 'internet' && this.state?.internet !== true) throw new Error(strings.contacts.invite.internetOld);
      return this.#connected().call('contacts.invite', params);
    });
    if (invite) this.invite = invite;
    return invite !== null;
  }

  /** Every link not used yet stops working, the one shown included. */
  async cancelInvites(): Promise<void> {
    const done = await this.#run('cancel-invites', () => this.#connected().call('contacts.cancelInvites', {}));
    if (!done) return;
    this.invite = null;
    if (this.state) this.state.invitations = 0;
  }

  async join(link: string): Promise<Contact | null> {
    if (this.isBusy('join')) return null;
    const attempt = ++this.#joinAttempt;
    const until = Date.now() + JOIN_WAIT_MS;
    for (;;) {
      let wait = 0;
      const contact = await this.#run('join', async () => {
        try { return await this.#connected().call('contacts.join', { link }); } catch (error) {
          wait = retryAfter(error);
          throw error;
        }
      });
      const current = attempt === this.#joinAttempt;
      if (contact) {
        // A join stopped or replaced while its call was in flight still linked a contact: its words show unless newer ones do.
        if (current) this.joinWaiting = null;
        if (current || !this.joined) this.joined = contact;
        this.#put(contact);
        return contact;
      }
      // The inviter's Funnel name is not in public DNS yet: the invitation is unspent, so the same join goes again.
      if (!current || wait <= 0 || Date.now() + wait > until) {
        if (current) this.joinWaiting = null;
        return null;
      }
      this.joinWaiting = { until };
      await new Promise(resolve => setTimeout(resolve, wait));
      if (attempt !== this.#joinAttempt) return null;
    }
  }

  /** Ends a join waiting for the inviter's address. */
  stopJoin(): void {
    this.#joinAttempt += 1;
    this.joinWaiting = null;
  }
}

/** A join waits this long at most for the inviter's Funnel name to reach public DNS. */
const JOIN_WAIT_MS = 15 * 60_000;

/** The delay the core asks before the same join, 0 when it does not. */
function retryAfter(error: unknown): number {
  const wait = error instanceof RpcFailure ? (error.data as { retryAfterMs?: unknown } | undefined)?.retryAfterMs : undefined;
  return typeof wait === 'number' && Number.isFinite(wait) && wait > 0 ? Math.min(wait, 120_000) : 0;
}

const views = new WeakMap<Store, ContactsView>();

/** One view per machine, kept while its Store lives, so a second visit draws at once. */
export function contactsOf(store: Store): ContactsView {
  let view = views.get(store);
  if (!view) {
    view = new ContactsView(store);
    views.set(store, view);
  }
  return view;
}

/** A machine listed beside its contacts. */
export interface MachineContacts { machine: Machine; view: ContactsView }

/** A contact as the lists draw it, with the machine that holds it and how many of its requests and messages wait. */
export interface ContactRow { machine: Machine; contact: Contact; waiting: number }

/**
 * Keeps every listed machine's contacts read while a list is drawn, and
 * follows each machine's reconnections. Call it while a component starts and
 * read rows from what it returns: a derived that made a view would not see
 * that view's state change.
 */
export function watchContacts(machines: () => readonly Machine[]): () => MachineContacts[] {
  const views = $derived(machines().map(machine => ({ machine, view: contactsOf(machine.store) })));
  $effect(() => {
    const watched = views.map(entry => entry.view);
    const releases = untrack(() => watched.map(view => view.watch()));
    return () => { for (const release of releases) release(); };
  });
  $effect(() => { for (const { machine, view } of views) { void machine.store.client; void machine.store.connection; untrack(() => view.follow()); } });
  return () => views;
}

/** Every listed machine's contacts, in the order each core keeps them. */
export function contactRows(views: readonly MachineContacts[]): ContactRow[] {
  return views.flatMap(({ machine, view }) => (view.state?.contacts ?? []).map(contact => ({
    machine,
    contact,
    waiting: view.state!.requests.filter(request => request.coreId === contact.coreId && request.direction === 'in' && request.status === 'pending').length
      + (view.state!.mail ?? []).filter(letter => letter.coreId === contact.coreId).length
  })));
}

/** Opens a contact's page, or the page that adds one, on the machine that holds it. */
/** Where the invitee is, seen from this machine: what an invitation must carry to reach it. */
export type InviteReach = 'tailnet' | 'share' | 'internet';

export async function openContact(owner: Store, coreId: string | null): Promise<void> {
  if (workspace.active !== owner) await workspace.select(owner);
  owner.showHome(coreId);
}

/** Pending requests first, newest first within each half. */
export function splitRequests(requests: readonly ContactRequest[]): { pending: ContactRequest[]; decided: ContactRequest[] } {
  const newest = (a: ContactRequest, b: ContactRequest) => b.createdAt - a.createdAt;
  return {
    pending: requests.filter(request => request.status === 'pending').sort(newest),
    decided: requests.filter(request => request.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
  };
}

/** A contact's initials for its badge: the first letters of its first two words. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${[...words[0]!][0]}${[...words[1]!][0]}` : [...(words[0] ?? '?')].slice(0, 2).join('');
  return letters.toUpperCase();
}

/** The four fingerprint words, however the core spaced or hyphenated them. */
export function fingerprintWords(fingerprint: string): string[] {
  return fingerprint.split(/[\s-]+/).filter(Boolean);
}

/**
 * Copies `text`. A page served over plain HTTP has no clipboard API: the field
 * holding it is selected and copied the older way, and stays selected to copy
 * by hand. True once something reached the clipboard.
 */
export async function copyText(text: string, field?: HTMLInputElement | HTMLTextAreaElement | null): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    field?.focus();
    field?.select();
    return !!field && !!document.execCommand?.('copy');
  }
}
