/*
 * Making an invitation: the origin the invitee dials, the share or the Funnel
 * mounts it needs, and the one-time token, kept as its hash.
 *
 * The origin depends on where the invitee is. On this tailnet, or on another
 * tailscale.com tailnet once a share reaches it, the invitee dials this
 * machine's tailnet name. Anywhere else (a Headscale tailnet, no Tailscale),
 * no share can reach it: the link names the contact routes on Tailscale
 * Funnel (`funnel.ts`).
 */
import type { ContactInvite } from '@boite/contracts';
import type { Core } from '../core.ts';
import { invalidParams, refused, unavailable } from '../errors.ts';
import { tailnetAddress } from '../group/addresses.ts';
import { newToken } from '../ids.ts';
import { encodeInvite, INVITE_TTL_MS, tokenHash } from './invite.ts';
import type { ContactStore } from './store.ts';

export const INVITES = 'contacts:invites';
export const MAX_INVITES = 16;

/** The invitations neither spent nor expired, by token hash. */
export function liveInvites(core: Core): [string, { expiresAt: number }][] {
  const now = Date.now();
  return Object.entries((core.journal.getSetting(INVITES) as Record<string, { expiresAt: number }> | undefined) ?? {}).filter(([, invite]) => invite.expiresAt > now);
}

/**
 * `share` false: the invitee already reaches this machine on Tailscale, so
 * no share is made or asked for. `internet`: the invitee is on another
 * network, so the link names the contact routes on Tailscale Funnel and no
 * share either.
 */
export async function createInvite(store: ContactStore, core: Core, share: unknown, internet: unknown): Promise<ContactInvite> {
  if (typeof share !== 'boolean') throw invalidParams('share: expected true or false', { field: 'share' });
  if (typeof internet !== 'boolean') throw invalidParams('internet: expected true or false', { field: 'internet' });
  const room = (): void => {
    if (store.list().length >= store.maxContacts) throw refused(`at most ${store.maxContacts} contacts; remove one first`);
    if (liveInvites(core).length >= MAX_INVITES) throw refused(`at most ${MAX_INVITES} open invitations; cancel them or wait for one to be used or to expire`);
  };
  room();
  // An invitation for another network holds the Funnel mounts until its token is saved, or until it gives up.
  const unhold = internet ? store.funnel.hold() : null;
  let saved = false;
  try {
    let url: string;
    let shared: ContactInvite['share'] = { status: 'none' };
    if (internet) url = await store.funnel.mount(() => store.internetUrl());
    else {
      url = await store.selfUrl(share);
      if (share) shared = await store.tailscale.shareFor(tailnetAddress());
    }
    // Read again after the awaits: another invitation may have been made meanwhile.
    room();
    const token = newToken();
    const expiresAt = Date.now() + INVITE_TTL_MS;
    core.journal.setSetting(INVITES, Object.fromEntries([...liveInvites(core), [tokenHash(token), { expiresAt }]]));
    saved = true;
    // Dialled from now on: the tailnet listener opens before the link leaves this machine.
    store.relisten();
    store.arm();
    const link = encodeInvite({ ...store.card(), url, token, share: shared.status === 'created' ? shared.url : null, expiresAt });
    // The owner sees whether the internet reaches the link's origin before sending it.
    if (internet) store.funnel.watch(url);
    store.changed();
    return { link, expiresAt, share: shared, via: internet ? 'internet' : 'tailnet' };
  } finally {
    unhold?.();
    // Mounts made for an invitation never saved leave with the rest when nothing else needs them.
    if (internet && !saved) store.relisten();
  }
}

/** This machine's tailnet origin for an invitee on Tailscale, refused with the reason when none can reach it. */
export async function tailnetOrigin(store: ContactStore, core: Core, share: boolean): Promise<string> {
  const { fqdn } = await store.tailscaleState(true);
  if (fqdn === null) {
    throw unavailable(tailnetAddress() === null
      ? 'contacts.invite: this machine is not on a tailnet; connect it to Tailscale, then invite again'
      : 'contacts.invite: Tailscale gave this machine no name; turn MagicDNS on for the tailnet, then invite again');
  }
  // Only tailscale.com shares machines between tailnets: a Headscale one never meets another.
  if (share && !fqdn.endsWith('.ts.net')) {
    throw unavailable(`contacts.invite: ${fqdn} is on a tailnet that cannot share a machine with another one (Headscale); for someone on another network, ask them to invite you, or add them to your tailnet and invite them as already on it`);
  }
  return `http://${fqdn}:${core.boundEndpoint().port}`;
}
