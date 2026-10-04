import { untrack } from 'svelte';
import { RPC_PATH, type Group, type GroupCore } from '@boite/contracts';
import { WsClient } from './client';
import { DROPPED_STORAGE_KEY, isDropped, isMemberDropped, readEnvironments, removeBrought, type Endpoint, type StoredEnvironment } from './endpoint';
import { usableAddresses } from './group-addresses';
import type { Machine, Workspace } from './workspace.svelte';

/** A machine that did not answer is asked again no sooner than this. */
const RETRY_MS = 60_000;
const PROBE_MS = 4000;
/** At start, how long the machines paired by hand are given to answer before a held key is used as it was left. */
const VOUCH_WAIT_MS = 3000;

/** Why a machine of the group is not connected from this client. */
export type GroupLinkState =
  | 'connecting'
  /** None of its addresses answered: it is off, asleep or on another network. */
  | 'unreachable'
  /** It gives no address this client may send a key to: see `usableAddresses`. */
  | 'insecure';

export interface GroupLinkOptions {
  /** The first address that accepts a socket, or null. Replaced in tests, which have no network. */
  reach?: (addresses: string[]) => Promise<string | null>;
  /** Whether this page may only open secure sockets. */
  secure?: () => boolean;
  now?: () => number;
  /** What a machine says its group is, undefined when it gave no answer in time. Replaced in tests, which have no network. */
  ask?: (endpoint: Endpoint, patience: number) => Promise<Group | null | undefined>;
  /** Replaces `VOUCH_WAIT_MS` in tests. */
  patience?: number;
}

/** One question to a machine paired by hand, on a socket made for it and closed with the answer. */
function askGroup(endpoint: Endpoint, patience: number): Promise<Group | null | undefined> {
  const client = new WsClient({ url: endpoint.url, token: endpoint.token, paired: endpoint.paired === true, reconnect: false });
  return Promise.race([
    client.connect().then(() => client.call('group.get', {})).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), patience))
  ]).finally(() => client.close());
}

export { usableAddresses };

/** A key the group brought for a plain HTTP address: at start it waits for a hand-paired machine to have its say. */
export function holdsBack(entry: StoredEnvironment): boolean {
  return entry.coreId !== undefined && entry.url.startsWith('http://');
}

/** Resolves with `url` once a WebSocket opens on it. No hello is sent: the socket only proves the address answers. */
function opens(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url.replace(/^http/, 'ws') + RPC_PATH);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const settle = (ok: boolean): void => {
      clearTimeout(timer);
      socket.onopen = socket.onerror = socket.onclose = null;
      try { socket.close(); } catch { /* never opened */ }
      if (ok) resolve(url);
      else reject(new Error('unreachable'));
    };
    const timer = setTimeout(() => settle(false), PROBE_MS);
    socket.onopen = () => settle(true);
    socket.onerror = () => settle(false);
    socket.onclose = () => settle(false);
  });
}

async function firstReachable(addresses: string[]): Promise<string | null> {
  try {
    return await Promise.any(addresses.map(opens));
  } catch {
    return null;
  }
}

/**
 * The machines of a group, connected without a pairing link each.
 *
 * A machine this client holds a key for says which group it is in. For every
 * other member, that machine is asked for a ticket, the member exchanges it for
 * a key of its own, and the key is kept like any pairing's: the member is then
 * reached directly, whether or not the machine that vouched is on.
 *
 * Who is in a group is read off the machines this client was paired with by
 * hand, the one it opened on included: they are what it trusts to begin with.
 * A machine the group brought vouches for nothing and lists nothing here, or a
 * removed one, still connected and still listing itself and its friends, would
 * keep them all in place. Such a machine goes when one of those hand-paired
 * machines, in the same group, no longer lists it. A machine paired by hand is
 * never touched.
 */
export class GroupLinks {
  /** Per core id, for the machines of the group this client is not connected to. */
  states = $state<Record<string, GroupLinkState>>({});
  #attempts = new Map<string, number>();
  #movedAt = new Map<string, number>();
  #running = new Set<string>();
  #reach: (addresses: string[]) => Promise<string | null>;
  #secure: () => boolean;
  #now: () => number;
  #patience: number;
  #ask: (endpoint: Endpoint, patience: number) => Promise<Group | null | undefined>;

  constructor(private readonly workspace: Workspace, options: GroupLinkOptions = {}) {
    this.#reach = options.reach ?? firstReachable;
    this.#secure = options.secure ?? (() => window.location.protocol === 'https:');
    this.#now = options.now ?? Date.now;
    this.#patience = options.patience ?? VOUCH_WAIT_MS;
    this.#ask = options.ask ?? askGroup;
  }

  /**
   * At start, before a key the group brought over plain HTTP is sent anywhere:
   * the machines paired by hand are asked, each on a socket made for the
   * question, what their group lists. A key for an address its machine no
   * longer gives, or for a machine the group dropped, is forgotten unsent, and
   * `reconcile` reaches that machine anew. With nobody of that group
   * answering, the machine that vouched being off, the key is used as it was left.
   */
  async vet(held: StoredEnvironment[], anchors: Endpoint[]): Promise<StoredEnvironment[]> {
    if (held.length === 0) return [];
    const answers = await Promise.all(anchors.map((anchor) => this.#ask(anchor, this.#patience).catch(() => undefined)));
    return held.filter((entry) => {
      const voices = answers.filter((answer): answer is Group => answer != null && answer.id === entry.groupId);
      if (voices.length === 0) return true;
      const stands = voices.every((voice) => {
        const core = voice.cores.find((listed) => listed.coreId === entry.coreId);
        return core !== undefined && usableAddresses(core.addresses, this.#secure()).includes(entry.url);
      });
      // Forgotten only while it is still the group's entry: the owner may have paired that machine by hand meanwhile.
      // No longer listed, the machine was dropped and its address is marked; listed elsewhere, it only moved.
      const delisted = voices.some((voice) => !voice.cores.some((listed) => listed.coreId === entry.coreId));
      if (!stands && entry.coreId !== undefined) {
        removeBrought(entry.url, { coreId: entry.coreId, ...(entry.groupId === undefined ? {} : { groupId: entry.groupId }) }, delisted ? entry.epoch ?? Number.MAX_SAFE_INTEGER : undefined);
      }
      return stands;
    });
  }

  /** Runs for the whole window: every roster change and every reconnect is looked at again. */
  start(): () => void {
    const timer = setInterval(() => void this.reconcile(), RETRY_MS);
    const stop = $effect.root(() => {
      $effect(() => {
        // Read so the effect follows them: the list, each connection, each roster.
        for (const machine of this.workspace.machines) {
          void machine.store.connection;
          void machine.store.group;
          void machine.store.groupKnown;
        }
        void this.workspace.settled;
        untrack(() => void this.reconcile());
      });
    });
    // Another window dropped a machine: this one lets it go too, without waiting for its own machines to say so.
    const heard = (event: StorageEvent): void => { if (event.key === DROPPED_STORAGE_KEY) void this.reconcile(); };
    window.addEventListener('storage', heard);
    return () => {
      clearInterval(timer);
      window.removeEventListener('storage', heard);
      stop();
    };
  }

  /** The member of the group this machine is: what it says itself, or what the group said when it brought it. */
  static coreOf(machine: Machine): string | undefined {
    return machine.store.group?.self ?? machine.coreId;
  }

  async reconcile(): Promise<void> {
    // Told by another window that the group dropped a machine: it goes at once, whoever answers here and whatever this window still loads.
    // By its address or by what it is: the machine may be held here under another address than the one that was marked.
    for (const machine of [...this.workspace.machines]) {
      if (machine.coreId === undefined) continue;
      if (isDropped(machine.id, machine.epoch) || isMemberDropped(machine.groupId, machine.coreId, machine.epoch)) await this.#drop(machine, true);
    }
    // Remembered machines are still being added: one of them may be the member that looks missing.
    if (!this.workspace.settled) return;
    // Only a machine that has answered about its group speaks here; one still loading neither vouches nor denies.
    const informed = this.workspace.machines.filter((machine) => machine.store.connection === 'ready' && machine.store.client !== null && machine.store.groupKnown);
    if (informed.length === 0) return;

    // What the group brought vouches for nothing: only what was paired by hand says who is in a group.
    const anchors = informed.filter((machine) => machine.coreId === undefined);
    await this.#prune(informed, anchors);

    const wanted = new Map<string, { core: GroupCore; via: Machine; addresses: string[] }>();
    for (const via of anchors) {
      const group = via.store.group;
      // The fake core has no address to dial and stands for itself.
      if (group === null || via.store.endpointUrl === null) continue;
      for (const core of group.cores) {
        if (core.coreId === group.self || wanted.has(core.coreId)) continue;
        // The group dropped this admission of the machine: a member still listing it has not caught up.
        if (isMemberDropped(group.id, core.coreId, core.epoch)) continue;
        // Two hand-paired machines of one group that disagree: the one that no longer lists it wins.
        if (anchors.some((other) => other.store.group?.id === group.id && !other.store.group.cores.some((listed) => listed.coreId === core.coreId))) continue;
        // An address the group dropped that machine at is not dialled on the word of a member still listing
        // the admission that was dropped: only a later admission, the machine having come back, opens it again.
        wanted.set(core.coreId, { core, via, addresses: this.#agreed(core.coreId, group.id, anchors).filter((address) => !isDropped(address, core.epoch)) });
      }
    }

    const states: Record<string, GroupLinkState> = {};
    const starting: { core: GroupCore; via: Machine; addresses: string[] }[] = [];
    for (const [coreId, state] of Object.entries(this.states)) if (wanted.has(coreId)) states[coreId] = state;
    for (const [coreId, { core, via, addresses }] of wanted) {
      let existing = this.workspace.machines.find((machine) => GroupLinks.coreOf(machine) === coreId);
      // A key the group handed out for an address the machine no longer gives, or no longer
      // allows now that it has HTTPS, is not sent there again: the machine is reached anew.
      if (existing?.coreId !== undefined && !addresses.includes(existing.id)) {
        await this.#drop(existing, false);
        existing = undefined;
      }
      if (existing !== undefined && (existing.store.connection !== 'closed' || this.#holdsKey(existing))) {
        delete states[coreId];
        continue;
      }
      if (this.#running.has(coreId) || this.#now() - (this.#attempts.get(coreId) ?? -RETRY_MS) < RETRY_MS) continue;
      states[coreId] = 'connecting';
      starting.push({ core, via, addresses });
    }
    // Written before any attempt starts: one that ends at once writes its own state after this.
    this.states = states;
    for (const { core, via, addresses } of starting) void this.#connect(core, via, addresses);
  }

  /**
   * Where a key for this member may be sent: the addresses every hand-paired
   * machine of that group that lists it allows. One of them holding an older
   * roster must not have a ticket sent to an address the member gave up; until
   * they agree, the member waits. The member itself is the last word: a ticket
   * names its address, and a machine refuses one made for an address it no
   * longer gives.
   */
  #agreed(coreId: string, groupId: string, anchors: readonly Machine[]): string[] {
    const lists = anchors.flatMap((machine) => {
      const group = machine.store.group;
      const core = group?.id === groupId ? group.cores.find((listed) => listed.coreId === coreId) : undefined;
      return core === undefined ? [] : [usableAddresses(core.addresses, this.#secure())];
    });
    return (lists[0] ?? []).filter((address) => lists.every((list) => list.includes(address)));
  }

  /**
   * Drops what the group brought and no longer lists. The voice that counts is
   * a hand-paired machine of the group that brought it, and one is enough: the
   * machine's own roster still lists it after its removal, another machine the
   * group brought may be its accomplice, and a machine of another group knows
   * nothing of this one.
   */
  async #prune(informed: readonly Machine[], anchors: readonly Machine[]): Promise<void> {
    for (const machine of [...this.workspace.machines]) {
      if (machine.coreId === undefined || machine.groupId === undefined) continue;
      const witnesses = anchors.filter((other) => other !== machine && other.store.group?.id === machine.groupId);
      const delisted = witnesses.some((other) => !other.store.group!.cores.some((core) => core.coreId === machine.coreId));
      // Its key was taken away and nobody it could be vouched by is in that group any more: nothing left to reconnect with.
      const orphaned = machine.store.connection === 'closed' && !this.#holdsKey(machine)
        && !informed.some((other) => other !== machine && other.coreId === undefined && other.store.group?.id === machine.groupId);
      if (!delisted && !orphaned) continue;
      await this.#drop(machine, delisted);
    }
  }

  /** The machine this window opened on cannot leave the list: its key goes and the window falls back to its own core. */
  /** `gone`: the group dropped it, and its address is marked for every window. Otherwise it only moved, or its key died. */
  async #drop(machine: Machine, gone: boolean): Promise<void> {
    if (machine.store === this.workspace.primary) await this.workspace.dropPrimary(machine.id, gone);
    else await this.workspace.remove(machine.id, gone);
  }

  /** A remembered key reconnects by itself; a machine without one needs a ticket again. */
  #holdsKey(machine: Machine): boolean {
    return readEnvironments().some((env) => env.url === machine.id && env.token !== '');
  }

  /** The agreed addresses of a member as the rosters stand now: none once a hand-paired machine of that group no longer lists it. */
  #allowed(coreId: string, groupId: string): string[] {
    const anchors = this.workspace.machines.filter((machine) => machine.coreId === undefined && machine.store.connection === 'ready'
      && machine.store.client !== null && machine.store.groupKnown && machine.store.group?.id === groupId);
    if (anchors.some((machine) => !machine.store.group!.cores.some((listed) => listed.coreId === coreId))) return [];
    return this.#agreed(coreId, groupId, anchors);
  }

  async #connect(core: GroupCore, via: Machine, addresses: string[]): Promise<void> {
    const coreId = core.coreId;
    this.#running.add(coreId);
    this.#attempts.set(coreId, this.#now());
    let state: GroupLinkState | null = 'unreachable';
    let moved = false;
    try {
      if (addresses.length === 0) {
        state = 'insecure';
        return;
      }
      const url = await this.#reach(addresses);
      const client = via.store.client;
      const groupId = via.store.group?.id;
      if (url === null || client === null || groupId === undefined) return;
      // The rosters may have changed while the address was tried: it must still be one every hand-paired machine allows.
      if (!this.#allowed(coreId, groupId).includes(url)) {
        moved = true;
        return;
      }
      // A machine paired by hand already sits at that address: it is that machine's to reach, with the key it has.
      if (this.workspace.machines.some((machine) => machine.id === url.replace(/\/+$/, '') && machine.coreId !== coreId)) {
        state = null;
        return;
      }
      // Asked for last: a ticket is good for a minute and for one socket.
      // The ticket names this address: the member refuses one made for an address it no longer gives.
      const { ticket } = await client.call('group.ticket', { coreId, url });
      // Asked again now that the ticket is here: the next line sends it.
      if (!this.#allowed(coreId, groupId).includes(url)) {
        moved = true;
        return;
      }
      if (await this.workspace.add({ url, token: '', ticket, coreId, groupId, epoch: core.epoch }, core.name, true)) state = null;
    } catch {
      // The machine that vouches went away, or the member refused: the next pass asks again.
    } finally {
      this.#running.delete(coreId);
      const states = { ...this.states };
      if (state === null) delete states[coreId];
      else states[coreId] = state;
      this.states = states;
      // The addresses changed under the attempt: the member is reached where they stand now, without
      // the minute's wait. Once a minute at most, or rosters made to flip would have tickets asked for without end.
      if (moved && this.#now() - (this.#movedAt.get(coreId) ?? -RETRY_MS) >= RETRY_MS) {
        this.#movedAt.set(coreId, this.#now());
        this.#attempts.delete(coreId);
        void this.reconcile();
      }
    }
  }
}
