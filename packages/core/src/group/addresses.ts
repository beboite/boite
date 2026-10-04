/*
 * Where the other members of a group reach this core.
 *
 * Tailscale is the expected network: every machine of a tailnet has a stable
 * address in 100.64.0.0/10 and, with MagicDNS, a name that follows it. Both
 * are read without the Tailscale CLI, which is not on every PATH and needs no
 * process here: the address is on Tailscale's own network interface, and the
 * name is the PTR record Tailscale's resolver at 100.100.100.100 answers for
 * it, which that interface routes to the local daemon. A machine with no
 * tailnet falls back to its LAN address, as a pairing link does.
 *
 * The name is for other cores, whose requests are sealed to this machine's
 * key: a name that resolved elsewhere would reach a machine that reads
 * nothing. Clients are not given a name over plain HTTP (`ownAddress`,
 * `usableAddresses` in the UI).
 */

import { Resolver } from 'node:dns/promises';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { lanAddress } from '../server/lan.ts';
import { ADDRESSES_MAX } from './roster.ts';

/** Tailscale's resolver, served by the local daemon on every machine of a tailnet. */
const MAGIC_DNS = '100.100.100.100';
const MAGIC_DNS_TIMEOUT_MS = 1500;

export interface Tailnet {
  ip: string;
  /** The MagicDNS name, when the tailnet has one for this machine. */
  name: string | null;
}

/** 100.64.0.0/10, the range Tailscale hands its addresses from. */
export function isTailnetAddress(address: string): boolean {
  const parts = address.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

/** fd7a:115c:a1e0::/48, the range Tailscale hands its IPv6 addresses from. */
function isTailnetV6(address: string): boolean {
  return /^fd7a:115c:a1e0:/i.test(address);
}

/**
 * Whether an interface is Tailscale's own. The address range alone is not
 * proof: 100.64.0.0/10 is also what a carrier or another VPN hands out, and a
 * listener opened there would face a network the owner never chose. Linux and
 * Windows name the interface (`tailscale0`, `Tailscale`); macOS gives it a
 * `utun` number like any tunnel, so there the Tailscale IPv6 address beside it
 * is what tells.
 */
function isTailscaleInterface(name: string, entries: readonly NetworkInterfaceInfo[]): boolean {
  if (/^tailscale/i.test(name)) return true;
  return /^utun\d+$/.test(name) && entries.some((entry) => isTailnetV6(entry.address));
}

/** This machine's tailnet address, or null. `BOITE_TAILNET=0` answers null: tests never open a tailnet port. */
export function tailnetAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env['BOITE_TAILNET'] === '0') return null;
  for (const [name, entries] of Object.entries(interfaces)) {
    if (entries === undefined || !isTailscaleInterface(name, entries)) continue;
    const found = entries.find((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal && isTailnetAddress(entry.address));
    if (found !== undefined) return found.address;
  }
  return null;
}

/** The name MagicDNS gives that address, or null when the tailnet has none or the resolver is silent. */
export async function magicName(ip: string): Promise<string | null> {
  const resolver = new Resolver({ timeout: MAGIC_DNS_TIMEOUT_MS, tries: 1 });
  try {
    resolver.setServers([MAGIC_DNS]);
    const names = await resolver.reverse(ip);
    const name = names[0]?.replace(/\.$/, '').toLowerCase();
    // A hostname only: this goes into an address other machines dial.
    return name !== undefined && /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name) ? name : null;
  } catch {
    return null;
  } finally {
    resolver.cancel();
  }
}

export interface Listening {
  /** The address the server bound: one host, `0.0.0.0` or `::`. */
  host: string;
  port: number;
  /** The server also answers on the tailnet address, through a listener of its own. */
  tailnet: boolean;
  publicUrl?: string | null;
}

function origin(host: string, port: number): string {
  return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** The public address as an origin. The setting stores one already; anything else is not an address to give. */
function publicOrigin(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins another machine dials, best first: the public HTTPS address a
 * phone needs, the tailnet name, the tailnet address, the LAN address. A core
 * that listens on itself only has just its loopback address to give, which
 * reaches it from the same computer and nowhere else.
 */
export function advertisedAddresses(
  listening: Listening,
  tailnet: Tailnet | null,
  lan: string | null = lanAddress(),
): string[] {
  const { host, port } = listening;
  const everywhere = host === '0.0.0.0' || host === '::';
  const addresses: string[] = [];
  const published = publicOrigin(listening.publicUrl);
  if (published !== null) addresses.push(published);
  if (tailnet !== null && (everywhere || listening.tailnet || host === tailnet.ip)) {
    if (tailnet.name !== null) addresses.push(origin(tailnet.name, port));
    addresses.push(origin(tailnet.ip, port));
  }
  if (everywhere && lan !== null) addresses.push(origin(lan, port));
  if (!everywhere && !LOOPBACK.has(host)) addresses.push(origin(host, port));
  if (addresses.length === 0) addresses.push(origin(everywhere ? '127.0.0.1' : host, port));
  return [...new Set(addresses)].slice(0, ADDRESSES_MAX);
}

/**
 * The addresses of a machine a client may send a ticket or a key to: the HTTPS
 * ones when it has any, else the ones written as numbers. It is the client's
 * own rule (`usableAddresses` in the UI), held by the core too: a ticket is
 * made for one of them, and a key lives while the machine still gives the one
 * it was issued for.
 */
export function ticketAddresses(addresses: readonly string[]): string[] {
  const https = addresses.filter((address) => address.startsWith('https://'));
  return https.length > 0 ? https : addresses.filter((address) => /^http:\/\/(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?$/i.test(address));
}

/**
 * The tailnet address of this machine now, and its name. The name is asked
 * for again when the address changed or `stale` says the last answer is old;
 * a resolver that stays silent once keeps the name it gave for that address.
 */
export async function probeTailnet(known: Tailnet | null, stale: boolean): Promise<Tailnet | null> {
  const ip = tailnetAddress();
  if (ip === null) return null;
  if (known?.ip === ip && !stale) return known;
  const name = await magicName(ip);
  return { ip, name: name ?? (known?.ip === ip ? known.name : null) };
}

/** What the server alone can do for the group: answer on one more address. */
export interface NetworkSink {
  /**
   * Listens on `host` beside the address the core was started on, or on no
   * extra address for null. True when a client that dials `host` reaches this
   * core, whether through that listener or the main one.
   */
  also(host: string | null): boolean;
}
