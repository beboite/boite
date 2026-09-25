import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * The IPv4 address a phone on the same network dials to reach this machine: a
 * private one first (home and office networks), then any other external one.
 * Null when the machine has no external IPv4 address at all.
 */
export function lanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string | null {
  const external = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal)
    .map((entry) => entry.address)
    // Link-local (169.254/16) is what Windows gives an adapter with no DHCP answer.
    .filter((address) => !address.startsWith('169.254.'));
  return external.find((address) => PRIVATE_V4.some((range) => range.test(address))) ?? external[0] ?? null;
}
