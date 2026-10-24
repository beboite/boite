/*
 * Whether the internet reaches this core through Tailscale Funnel, asked the
 * way an invitee's machine would.
 *
 * Tailscale publishes a Funnel name in public DNS a few minutes after Funnel
 * is turned on, and sometimes not at all until it is turned off and on again.
 * This machine cannot see that by itself: MagicDNS answers its own tailnet
 * name with its tailnet address. So the name is resolved over DNS-over-HTTPS
 * by public resolvers, then the join route is asked at one of the public
 * addresses they give, the TLS name still the Funnel one. A request with no
 * peer reaches `joinRequest`, which refuses it in its own words: that answer
 * is the proof the request went through Funnel to this core.
 */
import type { ContactFunnelStatus } from '@boite/contracts';

const DOH = [
  { url: 'https://dns.google/resolve', headers: {} },
  { url: 'https://cloudflare-dns.com/dns-query', headers: { accept: 'application/dns-json' } },
] as const;
const DOH_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 10_000;
/** How many of the public addresses are tried before the name counts as unreachable. */
const ADDRESSES_TRIED = 2;
/** What `joinRequest` answers a request naming no peer. */
const JOIN_REFUSAL = 'x-boite-peer:';

/** The public IPv4 addresses of `host`, `[]` when public DNS knows no such name, null when no resolver answered. */
export type PublicResolve = (host: string) => Promise<string[] | null>;
/** Status and the start of the body of a POST to `path` at `address`, TLS named `host`; null when nothing answered. */
export type PublicRequest = (address: string, host: string, port: number, path: string) => Promise<{ status: number; body: string } | null>;
/** Where the internet stands with `origin`, as seen through its route `path`. */
export type FunnelProbe = (origin: string, path: string) => Promise<Exclude<ContactFunnelStatus, 'checking'>>;

async function resolvePublic(host: string): Promise<string[] | null> {
  for (const resolver of DOH) {
    try {
      const response = await fetch(`${resolver.url}?name=${encodeURIComponent(host)}&type=A`, { headers: resolver.headers, signal: AbortSignal.timeout(DOH_TIMEOUT_MS) });
      if (!response.ok) continue;
      const answer = await response.json() as { Status?: unknown; Answer?: { type?: unknown; data?: unknown }[] };
      if (answer.Status === 3) return [];
      if (answer.Status !== 0) continue;
      return (answer.Answer ?? []).filter(record => record.type === 1 && typeof record.data === 'string').map(record => record.data as string);
    } catch { /* The next resolver. */ }
  }
  return null;
}

async function requestPublic(address: string, host: string, port: number, path: string): Promise<{ status: number; body: string } | null> {
  // Loaded here: only a machine with Funnel mounts asks.
  const { request } = await import('node:https');
  return new Promise(resolve => {
    const call = request({
      host: address, port, path, method: 'POST', servername: host, timeout: REQUEST_TIMEOUT_MS,
      headers: { host: `${host}:${port}`, 'content-length': '0' },
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { if (body.length < 200) body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: body.slice(0, 200) }));
      response.on('error', () => resolve(null));
    });
    call.on('timeout', () => call.destroy(new Error('no answer')));
    call.on('error', () => resolve(null));
    call.end();
  });
}

export function funnelProbe(resolve: PublicResolve = resolvePublic, ask: PublicRequest = requestPublic): FunnelProbe {
  return async (origin, path) => {
    const url = new URL(origin);
    const addresses = await resolve(url.hostname);
    if (addresses === null) return 'unknown';
    if (addresses.length === 0) return 'unpublished';
    for (const address of addresses.slice(0, ADDRESSES_TRIED)) {
      const answer = await ask(address, url.hostname, Number(url.port || 443), path);
      if (answer?.status === 403 && answer.body.startsWith(JOIN_REFUSAL)) return 'ready';
    }
    return 'unreachable';
  };
}
