/**
 * Agent links between the machines this app holds owner connections to.
 * Two owner machines ready at the same time are linked for agent coordination
 * without a click, once per pair until one of them reconnects. A pair the user
 * unlinked stays unlinked until the user links it again by hand.
 */
import { untrack } from 'svelte';
import type { CoordinationPeer } from '@boite/contracts';
import { workspace, type Machine } from './workspace.svelte';
import { fill, strings } from './strings';
import { bridgeMachines, closeBridges, forgetBridge, pruneBridges } from './agent-link-bridge';

const UNLINKED_KEY = 'boite.agent-links.unlinked';

function pairOf(a: string, b: string): string {
  return [a, b].sort().join('|');
}

function unlinkedPairs(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(UNLINKED_KEY) ?? '[]') as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch { return new Set(); }
}

function saveUnlinked(pairs: Set<string>): void {
  try { localStorage.setItem(UNLINKED_KEY, JSON.stringify([...pairs])); } catch { /* session only */ }
}

/** The user removed a link between these two cores: the automatic link leaves them alone. */
export function rememberUnlinked(coreA: string, coreB: string): void {
  const pairs = unlinkedPairs();
  pairs.add(pairOf(coreA, coreB));
  saveUnlinked(pairs);
}

/** The user linked these two cores by hand: an earlier removal no longer holds. */
export function forgetUnlinked(coreA: string, coreB: string): void {
  const pairs = unlinkedPairs();
  if (pairs.delete(pairOf(coreA, coreB))) saveUnlinked(pairs);
}

export function isUnlinked(coreA: string, coreB: string): boolean {
  return unlinkedPairs().has(pairOf(coreA, coreB));
}

/** A loopback contact cannot be dialled by another machine. The authenticated
 * connection can supply its HTTPS origin when no public address was configured. */
function reachableIdentity(machine: Machine, identity: CoordinationPeer, bridge = false): CoordinationPeer {
  const usable = (raw: string): string | null => {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
      return url.origin;
    } catch { return null; }
  };
  const url = usable(identity.url) ?? usable(machine.store.endpointUrl ?? '');
  if (!url && bridge) return { ...identity, viaClient: true };
  if (!url) throw new Error(fill(strings.machines.agentLinkAddressRequired, { machine: machine.label }));
  return { ...identity, url, viaClient: false };
}

/**
 * Each core trusts the other, then both check the link in both directions.
 * A failure puts back what either core trusted before and throws.
 */
export async function linkMachines(a: Machine, b: Machine): Promise<void> {
  let trustedA = false;
  let trustedB = false;
  let aIdentity: CoordinationPeer | null = null;
  let bIdentity: CoordinationPeer | null = null;
  let previousA: CoordinationPeer | undefined;
  let previousB: CoordinationPeer | undefined;
  try {
    [aIdentity, bIdentity] = await Promise.all([a.store.coordinationIdentity(), b.store.coordinationIdentity()]);
    aIdentity = reachableIdentity(a, aIdentity, true);
    bIdentity = reachableIdentity(b, bIdentity, true);
    const [peersA, peersB] = await Promise.all([a.store.coordinationPeers(), b.store.coordinationPeers()]);
    previousA = peersA.find(p => p.coreId === bIdentity!.coreId);
    previousB = peersB.find(p => p.coreId === aIdentity!.coreId);
    await a.store.trustCoordinationPeer(bIdentity);
    trustedA = true;
    await b.store.trustCoordinationPeer(aIdentity);
    trustedB = true;
    if (!await bridgeMachines(a, b, aIdentity.coreId, bIdentity.coreId)) {
      // Older cores can still use direct HTTPS links, but cannot relay an unpublished local core.
      reachableIdentity(a, aIdentity); reachableIdentity(b, bIdentity);
    }
    await Promise.all([a.store.checkCoordinationPeer(bIdentity.coreId), b.store.checkCoordinationPeer(aIdentity.coreId)]);
  } catch (cause) {
    forgetBridge(a, b);
    let message = cause instanceof Error ? cause.message : String(cause);
    const rollbacks = await Promise.allSettled([
      (async () => { if (trustedA && bIdentity) { if (previousA) await a.store.trustCoordinationPeer(previousA); else await a.store.untrustCoordinationPeer(bIdentity.coreId); } })(),
      (async () => { if (trustedB && aIdentity) { if (previousB) await b.store.trustCoordinationPeer(previousB); else await b.store.untrustCoordinationPeer(aIdentity.coreId); } })(),
    ]);
    for (const rollback of rollbacks) if (rollback.status === 'rejected') message += ` ${rollback.reason instanceof Error ? rollback.reason.message : String(rollback.reason)}`;
    throw new Error(message);
  }
}

function ownerMachines(): Machine[] {
  return workspace.machines.filter(machine => machine.store.owner && machine.store.connection === 'ready');
}

function machinePair(a: Machine, b: Machine): string {
  return [a.id, b.id].sort().join('\0');
}

class AgentAutoLink {
  /** Why a pair of machines (by machine ids) could not be linked, until it reconnects. */
  failures = $state<Record<string, string>>({});
  /** Bumped after a link is made, so a screen showing the links reads them again. */
  version = $state(0);
  #tried = new Set<string>();
  #running = false;
  #again = false;

  failureOf(a: Machine, b: Machine): string | undefined {
    return this.failures[machinePair(a, b)];
  }

  async sweep(): Promise<void> {
    const ready = ownerMachines();
    pruneBridges(ready);
    const ids = new Set(ready.map(machine => machine.id));
    // A machine that dropped is tried again when it comes back: its identity or address may have changed.
    for (const key of [...this.#tried]) {
      if (key.split('\0').some(id => !ids.has(id))) {
        this.#tried.delete(key);
        if (key in this.failures) { const { [key]: _gone, ...rest } = this.failures; this.failures = rest; }
      }
    }
    if (this.#running) { this.#again = true; return; }
    this.#running = true;
    try {
      do {
        this.#again = false;
        const machines = ownerMachines();
        for (let i = 0; i < machines.length; i += 1) for (let j = i + 1; j < machines.length; j += 1) await this.#pair(machines[i]!, machines[j]!);
      } while (this.#again);
    } finally { this.#running = false; }
  }

  async #pair(a: Machine, b: Machine): Promise<void> {
    const key = machinePair(a, b);
    if (this.#tried.has(key)) return;
    this.#tried.add(key);
    try {
      // Whether the two share a group decides what is written: wait until both have said.
      if (!a.store.groupKnown || !b.store.groupKnown) { this.#tried.delete(key); return; }
      const [left, right] = await Promise.all([a.store.coordinationIdentity(), b.store.coordinationIdentity()]);
      // Two connections to one core are one machine.
      if (left.coreId === right.coreId || isUnlinked(left.coreId, right.coreId)) return;
      const [peersA, peersB] = await Promise.all([a.store.coordinationPeers(), b.store.coordinationPeers()]);
      // Machines of one group trust each other while both are members. A link written here
      // would outlive that: a machine removed from the group would keep reaching the other's agents.
      // What a machine says of its own group is not asked: a machine the group brought, or one
      // the other's roster lists, gets no standing link from this app, whatever it claims.
      const grouped = a.coreId !== undefined || b.coreId !== undefined
        || a.store.group?.cores.some(core => core.coreId === right.coreId) === true
        || b.store.group?.cores.some(core => core.coreId === left.coreId) === true;
      const linked = peersA.some(peer => peer.coreId === right.coreId) && peersB.some(peer => peer.coreId === left.coreId);
      if (grouped && !linked) {
        // No relay through this app: said under Agent links, and tried again when one of the two reconnects.
        if (!await bridgeMachines(a, b, left.coreId, right.coreId)) throw new Error(fill(strings.machines.agentLinkAddressRequired, { machine: b.label }));
      } else if (linked) {
        await bridgeMachines(a, b, left.coreId, right.coreId);
        // Persisted trust is configuration, not proof that either signed route still works.
        await Promise.all([a.store.checkCoordinationPeer(right.coreId), b.store.checkCoordinationPeer(left.coreId)]);
      } else await linkMachines(a, b);
      this.version += 1;
    } catch (cause) {
      this.failures = { ...this.failures, [key]: cause instanceof Error ? cause.message : String(cause) };
      this.version += 1;
    }
  }

  /** Watches the owner machines for the life of the app; the returned function stops it. */
  start(): () => void {
    const stop = $effect.root(() => {
      $effect(() => {
        ownerMachines().map(machine => `${machine.id}\0${machine.store.groupKnown}\0${machine.store.group?.id ?? ''}`).join('\0');
        untrack(() => { void this.sweep(); });
      });
    });
    return () => { stop(); closeBridges(); };
  }

  /** Tests start from nothing tried. */
  reset(): void {
    closeBridges();
    this.#tried.clear();
    this.failures = {};
  }
}

export const agentAutoLink = new AgentAutoLink();
