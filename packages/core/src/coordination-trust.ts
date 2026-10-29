/** Validate manual peer trust without widening Contacts or group permissions. */
import { createHash, createPublicKey } from 'node:crypto';
import type { CoordinationPeer } from '@boite/contracts';
import type { Core } from './core.ts';
import { invalidParams, refused } from './errors.ts';
import { coordinationUrl, text } from './coordination-letter.ts';
import { groupPeers, migrateGroupPeer } from './coordination-group.ts';

/**
 * Every machine a letter may cross to: the hand-made links first, so the
 * permissions the owner set on one win, then the members of this core's
 * group, then contacts, whose reach is decided per project (`contacts/store.ts`).
 */
export function trustedCoordinationPeers(core: Core): CoordinationPeer[] {
  const manual = core.coordination.peers();
  const own = [...manual, ...groupPeers(core).filter(peer => !manual.some(known => known.coreId === peer.coreId))];
  return [...own, ...(core.contacts?.peers() ?? []).filter(peer => !own.some(known => known.coreId === peer.coreId))];
}

export function trustCoordination(core: Core, peer: CoordinationPeer): CoordinationPeer {
    if (!peer) throw invalidParams('peer: expected a public contact card');
    const publicKey = text(peer.publicKey, 'peer.publicKey', 1000);
    let parsed: ReturnType<typeof createPublicKey>;
    try { parsed = createPublicKey(publicKey); }
    catch { throw invalidParams('peer.publicKey: expected Ed25519'); }
    if (parsed.asymmetricKeyType !== 'ed25519') throw invalidParams('peer.publicKey: expected Ed25519');
    const canonical = parsed.export({ type: 'spki', format: 'pem' }).toString();
    const coreId = createHash('sha256').update(canonical).digest('hex');
    if (coreId !== peer.coreId || coreId === core.coordination.card().coreId) throw invalidParams('peer.coreId: expected the other machine public key fingerprint');
    if (core.contacts.isContact(coreId)) throw refused('peer.coreId: that core is a contact; contacts are linked in Contacts');
    for (const field of ['readThreads', 'viaClient'] as const) if (peer[field] !== undefined && typeof peer[field] !== 'boolean') throw invalidParams(`peer.${field}: expected a boolean`);
    const previous = core.coordination.peers().find(p => p.coreId === coreId);
    const checked = { coreId, name: text(peer.name, 'peer.name', 100), url: coordinationUrl(peer.url), publicKey: canonical,
      readThreads: peer.readThreads ?? previous?.readThreads ?? false,
      viaClient: peer.viaClient ?? previous?.viaClient ?? false };
    const peers = core.coordination.peers().filter(p => p.coreId !== coreId);
    if (peers.length >= 32) throw refused('at most 32 coordination peers');
    core.journal.setSetting('coordination:peers', [...peers, checked]);
    if (core.group.peers().some(peer => peer.coreId === coreId)) migrateGroupPeer(core, checked);
    return checked;
}
