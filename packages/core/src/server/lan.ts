import { createSocket } from 'node:dgram';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import type { PairingNetwork } from '@boite/contracts';

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/**
 * Adapters a phone never reaches: the host-only and NAT networks of VMware,
 * VirtualBox, Hyper-V and WSL, container bridges and point-to-point tunnels.
 * On a Windows PC with VMware, `VMware Network Adapter VMnet8` holds a
 * 192.168.x address listed before the Wi-Fi card, and the pairing link named
 * it: the phone's QR code led nowhere.
 */
const VIRTUAL_ADAPTER =
  /vmware|vmnet|virtualbox|vbox|vethernet|hyper-v|\bwsl\b|docker|podman|^br-|^veth|^virbr|^lxcbr|^lxdbr|^incusbr|^cni|^flannel|^kube|^vmenet|^bridge\d|parallels|^tun|^tap|^wg|zerotier|^zt|npcap|bluetooth/i;

/** 100.64.0.0/10, the shared range Tailscale and Headscale give every node. */
export function isTailnetAddress(address: string): boolean {
  const match = /^100\.(\d+)\./.exec(address);
  return match !== null && Number(match[1]) >= 64 && Number(match[1]) <= 127;
}

export interface ReachableAddress {
  address: string;
  network: Exclude<PairingNetwork, 'public'>;
  interface: string;
}

/**
 * Every IPv4 address another device may dial to reach this machine, best
 * first: the one the default route leaves from, then private addresses of
 * real adapters, then a tailnet's. Virtual adapters only count when nothing
 * else exists. Link-local (169.254/16) is what Windows gives an adapter that
 * got no DHCP answer, and never counts.
 */
export function reachableAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  routed: string | null = null,
): ReachableAddress[] {
  const all = Object.entries(interfaces).flatMap(([name, entries]) =>
    (entries ?? [])
      .filter((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal)
      .filter((entry) => !entry.address.startsWith('169.254.'))
      .map((entry) => ({ name, address: entry.address })),
  );
  const rank = ({ name, address }: { name: string; address: string }): number => {
    if (isTailnetAddress(address)) return 3;
    // A Hyper-V external switch carries the real LAN under a vEthernet name: the route says so.
    if (address === routed) return 0;
    const virtual = VIRTUAL_ADAPTER.test(name);
    const private_ = PRIVATE_V4.some((range) => range.test(address));
    if (virtual) return 5;
    return private_ ? 1 : 2;
  };
  const ranked = all
    .map((entry, index) => ({ ...entry, rank: rank(entry), index }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index);
  const real = ranked.filter((entry) => entry.rank < 5);
  const kept = real.length > 0 ? real : ranked;
  const seen = new Set<string>();
  return kept
    .filter((entry) => !seen.has(entry.address) && seen.add(entry.address))
    .map((entry) => ({
      address: entry.address,
      network: entry.rank === 3 ? 'tailscale' : entry.rank === 2 ? 'other' : 'lan',
      interface: entry.name,
    }));
}

/**
 * The IPv4 address a phone on the same network dials to reach this machine:
 * the first of `reachableAddresses` outside a tailnet, else the tailnet's.
 * Null when the machine has no external IPv4 address at all.
 */
export function lanAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  routed: string | null = null,
): string | null {
  const addresses = reachableAddresses(interfaces, routed);
  return (addresses.find((entry) => entry.network !== 'tailscale') ?? addresses[0])?.address ?? null;
}

/**
 * The local address the default route leaves from, read the way the kernel
 * picks it: a UDP socket "connected" to a documentation address sends nothing
 * and only resolves the route. Null without a default route, when the route
 * goes through a tailnet exit node, or when the answer takes over 500 ms.
 */
export function routedAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    let socket: ReturnType<typeof createSocket> | null = null;
    const finish = (address: string | null) => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      socket = null;
      resolve(address !== null && address !== '0.0.0.0' && !isTailnetAddress(address) ? address : null);
    };
    const timer = setTimeout(() => finish(null), 500);
    try {
      socket = createSocket('udp4');
      socket.on('error', () => finish(null));
      socket.connect(53, '192.0.2.1', () => {
        try {
          finish(socket?.address().address ?? null);
        } catch {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}
