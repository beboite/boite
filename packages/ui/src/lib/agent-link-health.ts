import type { CoordinationPeer } from '@boite/contracts';
import type { Machine } from './workspace.svelte';

export type LinkHealth = { ok: boolean; error: string | null };
export type MachineLinks = { id: string; identity: CoordinationPeer; peers: CoordinationPeer[]; health: Record<string, LinkHealth> };

/** Configuration survives disconnects; a successful signed check is a separate observation. */
export async function loadMachineLinks(machine: Machine): Promise<MachineLinks> {
  try {
    const [identity, peers] = await Promise.all([machine.store.coordinationIdentity(), machine.store.coordinationPeers()]);
    const checks = await Promise.all(peers.map(async peer => {
      try {
        await machine.store.checkCoordinationPeer(peer.coreId);
        return [peer.coreId, { ok: true, error: null }] as const;
      } catch (cause) {
        return [peer.coreId, { ok: false, error: `${machine.label}: ${cause instanceof Error ? cause.message : String(cause)}` }] as const;
      }
    }));
    return { id: machine.id, identity, peers, health: Object.fromEntries(checks) };
  } catch (cause) { throw new Error(`${machine.label}: ${cause instanceof Error ? cause.message : String(cause)}`); }
}
