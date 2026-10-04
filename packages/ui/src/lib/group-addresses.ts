/** Where a client may send a ticket or a key of a group. Shared by the group links and the in-memory core, as the real core holds the same rule. */

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
