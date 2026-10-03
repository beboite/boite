/*
 * Where the other members of a group reach this core.
 *
 * Tailscale is the expected network: every machine of a tailnet has a stable
 * address in 100.64.0.0/10 and, with MagicDNS, a name that follows it. Both
 * are read without the Tailscale CLI, which is not on every PATH and needs no
 * process here: the address is on a network interface, and the name is the
 * PTR record Tailscale's own resolver at 100.100.100.100 answers for it. A
 * machine with no tailnet falls back to its LAN address, as a pairing link
 * does.
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

/** This machine's tailnet address, or null. `BOITE_TAILNET=0` answers null: tests never open a tailnet port. */
export function tailnetAddress(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (env['BOITE_TAILNET'] === '0') return null;
  const found = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .find((entry) => (entry.family === 'IPv4' || (entry.family as unknown) === 4) && !entry.internal && isTailnetAddress(entry.address));
  return found?.address ?? null;
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
