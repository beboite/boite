import { untrack } from 'svelte';
import { RPC_PATH, type GroupCore } from '@boite/contracts';
import { readEnvironments } from './endpoint';
import type { Machine, Workspace } from './workspace.svelte';

/** A machine that did not answer is asked again no sooner than this. */
const RETRY_MS = 60_000;
const PROBE_MS = 4000;

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

/** `http://` followed by an address written as numbers, IPv4 or bracketed IPv6: nothing a resolver gets a say in. */
const LITERAL_HTTP = /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i;

/**
 * The addresses of a machine this client may send a ticket and then a key to.
 * The client link is not sealed, so the transport has to say who answers:
 *
 * - a machine that gives an HTTPS address is reached there and nowhere else,
 *   so nothing on the path can talk the client down to plain HTTP;
 * - over plain HTTP only an address written as numbers: a name is whatever the
 *   resolver of this device says it is, and may be another host;
 * - an HTTPS page opens secure sockets only.
 */
export function usableAddresses(addresses: readonly string[], secure: boolean): string[] {
  const https = addresses.filter((address) => address.startsWith('https://'));
  if (https.length > 0 || secure) return https;
  return addresses.filter((address) => LITERAL_HTTP.test(address));
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
  #running = new Set<string>();
  #reach: (addresses: string[]) => Promise<string | null>;
  #secure: () => boolean;
  #now: () => number;

  constructor(private readonly workspace: Workspace, options: GroupLinkOptions = {}) {
    this.#reach = options.reach ?? firstReachable;
    this.#secure = options.secure ?? (() => window.location.protocol === 'https:');
    this.#now = options.now ?? Date.now;
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
    return () => {
      clearInterval(timer);
      stop();
    };
  }

  /** The member of the group this machine is: what it says itself, or what the group said when it brought it. */
  static coreOf(machine: Machine): string | undefined {
    return machine.store.group?.self ?? machine.coreId;
  }

  async reconcile(): Promise<void> {
    // Remembered machines are still being added: one of them may be the member that looks missing.
    if (!this.workspace.settled) return;
    // Only a machine that has answered about its group speaks here; one still loading neither vouches nor denies.
    const informed = this.workspace.machines.filter((machine) => machine.store.connection === 'ready' && machine.store.client !== null && machine.store.groupKnown);
    if (informed.length === 0) return;

    // What the group brought vouches for nothing: only what was paired by hand says who is in a group.
    const anchors = informed.filter((machine) => machine.coreId === undefined);
    await this.#prune(informed, anchors);

    const wanted = new Map<string, { core: GroupCore; via: Machine }>();
    for (const via of anchors) {
      const group = via.store.group;
      // The fake core has no address to dial and stands for itself.
      if (group === null || via.store.endpointUrl === null) continue;
      for (const core of group.cores) {
        if (core.coreId === group.self || wanted.has(core.coreId)) continue;
        // Two hand-paired machines of one group that disagree: the one that no longer lists it wins.
        if (anchors.some((other) => other.store.group?.id === group.id && !other.store.group.cores.some((listed) => listed.coreId === core.coreId))) continue;
        wanted.set(core.coreId, { core, via });
      }
    }

    const states: Record<string, GroupLinkState> = {};
    const starting: { core: GroupCore; via: Machine }[] = [];
    for (const [coreId, state] of Object.entries(this.states)) if (wanted.has(coreId)) states[coreId] = state;
    for (const [coreId, { core, via }] of wanted) {
      let existing = this.workspace.machines.find((machine) => GroupLinks.coreOf(machine) === coreId);
      // A key the group handed out for an address the machine no longer gives, or no longer
      // allows now that it has HTTPS, is not sent there again: the machine is reached anew.
      if (existing?.coreId !== undefined && existing.store !== this.workspace.primary && !usableAddresses(core.addresses, this.#secure()).includes(existing.id)) {
        await this.workspace.remove(existing.id);
        existing = undefined;
      }
      if (existing !== undefined && (existing.store.connection !== 'closed' || this.#holdsKey(existing))) {
        delete states[coreId];
        continue;
      }
      if (this.#running.has(coreId) || this.#now() - (this.#attempts.get(coreId) ?? -RETRY_MS) < RETRY_MS) continue;
      states[coreId] = 'connecting';
      starting.push({ core, via });
    }
    // Written before any attempt starts: one that ends at once writes its own state after this.
    this.states = states;
    for (const { core, via } of starting) void this.#connect(core, via);
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
      if (machine.store === this.workspace.primary) await machine.store.forgetEnvironment(machine.id);
      else await this.workspace.remove(machine.id);
    }
  }

  /** A remembered key reconnects by itself; a machine without one needs a ticket again. */
  #holdsKey(machine: Machine): boolean {
    return readEnvironments().some((env) => env.url === machine.id && env.token !== '');
  }

  async #connect(core: GroupCore, via: Machine): Promise<void> {
    const coreId = core.coreId;
    this.#running.add(coreId);
    this.#attempts.set(coreId, this.#now());
    let state: GroupLinkState | null = 'unreachable';
    try {
      const addresses = usableAddresses(core.addresses, this.#secure());
      if (addresses.length === 0) {
        state = 'insecure';
        return;
      }
      const url = await this.#reach(addresses);
      const client = via.store.client;
      const groupId = via.store.group?.id;
      if (url === null || client === null || groupId === undefined) return;
      // A machine paired by hand already sits at that address: it is that machine's to reach, with the key it has.
      if (this.workspace.machines.some((machine) => machine.id === url.replace(/\/+$/, '') && machine.coreId !== coreId)) {
        state = null;
        return;
      }
      // Asked for last: a ticket is good for a minute and for one socket.
      const { ticket } = await client.call('group.ticket', { coreId });
      if (await this.workspace.add({ url, token: '', ticket, coreId, groupId }, core.name, true)) state = null;
    } catch {
      // The machine that vouches went away, or the member refused: the next pass asks again.
    } finally {
      this.#running.delete(coreId);
      const states = { ...this.states };
      if (state === null) delete states[coreId];
      else states[coreId] = state;
      this.states = states;
    }
  }
}
