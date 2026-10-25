/** What the peer address and Host of a socket say about who can read it. */
import { isTailnetAddress, isTailnetV6 } from '../group/addresses.ts';

/**
 * The name the client dialled, from its `Host` header. A tunnel or a reverse
 * proxy on this machine connects from 127.0.0.1 too, so the peer address says
 * nothing; the name it forwards is the public one.
 */
export function isLoopbackHost(header: string | null): boolean {
  if (header === null) return false;
  const name = header.trim().toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

/** The peer address `Server.requestIP` gives, IPv4-mapped IPv6 included. */
export function isLoopbackAddress(address: string | null): boolean {
  if (address === null) return false;
  const bare = address.toLowerCase().replace(/^::ffff:/, '');
  return bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

/**
 * The header a member of the group sets when it carries a client's socket to
 * another member (`group/relay.ts`): `encrypted` or `plain`, for the hop from
 * the client to it, which the member at the end cannot see.
 */
export const RELAYED_LINK_HEADER = 'x-boite-relayed-link';

/**
 * Whether nobody between the client and this core can read the socket. The
 * core serves no TLS itself, so a peer on the LAN is plain HTTP. A Tailscale
 * peer comes through WireGuard, counted only while this machine is on a
 * tailnet: 100.64.0.0/10 is also a carrier's range. A loopback peer is this
 * machine: its own app, or a TLS terminator here (tailscale serve, a reverse
 * proxy, a tunnel) whose page was HTTPS. A socket another member relays counts
 * only when its own hop was encrypted too (`relayedLink`).
 */
export function encryptedLink(address: string | null, host: string | null, origin: string | null, relayedLink: string | null = null, onTailnet = true): boolean {
  if (address === null || (relayedLink !== null && relayedLink !== 'encrypted')) return false;
  if (isLoopbackAddress(address)) return isLoopbackHost(host) || (origin?.toLowerCase().startsWith('https://') ?? false);
  const bare = address.toLowerCase().replace(/^::ffff:/, '');
  return onTailnet && (isTailnetAddress(bare) || isTailnetV6(bare));
}
