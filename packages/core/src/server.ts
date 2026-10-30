import type { ServerWebSocket } from 'bun';
import type { Channel, RpcEventName, RpcEvents, ThreadId } from '@boite/contracts';
import { APP_ORIGIN, FILE_ROUTE, RPC_MAX_FRAME_BYTES, RPC_PATH, RpcCloseCode, VIEW_ROUTE, SUBSCRIBED_EVENTS, agentHearsEvent } from '@boite/contracts';
import { timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { eventThreadId, type EventPayload } from './bus.ts';
import { mayReceiveEvent } from './access.ts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import { JOIN_ROUTE } from './group.ts';
import { CONTACT_JOIN_ROUTE, CONTACT_LINK_ROUTE } from './contacts/store.ts';
import type { ContactSocketData } from './contacts/link-hello.ts';
import { LAZY_MCP_ROUTE } from './mcp/lazy.ts';
import { tailnetAddress } from './group/addresses.ts';
import { encryptedLink, isLoopbackAddress, isLoopbackHost, RELAYED_LINK_HEADER } from './server/peer.ts';
import { parseRelayPath, RelayHub, type RelaySocketData } from './group/relay.ts';
import type { Connection } from './router.ts';
import type { EventFrames, SocketData } from './server/connection.ts';
import { OUTBOUND_MAX_BUFFERED_BYTES, ServerConnection } from './server/connection.ts';
import { loadRowSender } from './server/load-rows.ts';
import { clientField, logConnectionClosed } from './server/connection-log.ts';
import { handleFrame, refuseFrame } from './server/frame.ts';
import { authenticateToken } from './server/hello.ts';
import { FrameQueue } from './server/frame-queue.ts';
import { Refusals } from './server/refusals.ts';
import { ticketedFile, viewPage } from './server/tickets.ts';
export { ServerConnection } from './server/connection.ts';
export { encryptedLink, isLoopbackAddress, isLoopbackHost } from './server/peer.ts';

const DEFAULT_HELLO_TIMEOUT_MS = 5000;
/** A hello is a few hundred bytes; nothing larger is parsed from a socket nobody has authenticated. */
const PREAUTH_FRAME_MAX_BYTES = 64 * 1024;
/**
 * Sockets from other machines waiting for their hello at once. A real client
 * spends milliseconds there, so this only bounds a peer opening them by the
 * thousand. The owner's own machine is never counted, so no peer can lock the
 * shell or an agent out of the core by holding every place.
 */
const PREAUTH_SOCKETS_MAX = 32;
/** The same bound per LAN address, so one host cannot hold every place from the others. */
const PREAUTH_SOCKETS_PER_ADDRESS = 8;
/**
 * Seconds an HTTP connection may sit without a byte either way. No route here
 * holds a request open: the coordination POST answers at once, and a ticketed
 * file a paused video stops reading is fetched again by `Range`.
 */
const HTTP_IDLE_TIMEOUT_S = 60;
/** Scheduler snapshots replace each other; turn and message events still go out immediately. */
const SCHEDULER_WINDOW_MS = 16;

/**
 * The UI build. `packages/core/src` and `packages/core/dist` are the same depth,
 * so `../../ui/dist` is `packages/ui/dist` from either; a compiled core has no
 * repository above it and carries the build in a `ui` directory next to itself.
 */
function resolveUiDist(): string {
  const explicit = process.env.BOITE_UI_DIR;
  if (explicit) {
    if (!existsSync(join(explicit, 'index.html'))) throw new Error(`BOITE_UI_DIR must contain index.html: ${explicit}`);
    return explicit;
  }
  const fromModule = join(import.meta.dir, '..', '..', 'ui', 'dist');
  if (existsSync(fromModule)) return fromModule;
  const besideExecutable = join(dirname(process.execPath), 'ui');
  return existsSync(besideExecutable) ? besideExecutable : fromModule;
}

export const UI_DIST = resolveUiDist();

export const PLACEHOLDER_HTML =
  '<!doctype html><meta charset="utf-8"><title>Boite core</title><p>Boite core is running; the UI is not built</p>';

const SHELL_ORIGINS = ['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'];

/** The phone app's origin (`APP_ORIGIN`), or the one `BOITE_APP_ORIGIN` names: a page no core serves, accepted by all. */
export function appOrigin(env: Record<string, string | undefined> = process.env): string {
  const named = env['BOITE_APP_ORIGIN']?.trim();
  if (!named) return APP_ORIGIN;
  try {
    // Written in any case, with or without `:443` or a trailing slash, it is the same origin.
    const url = new URL(named);
    if (url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash) return url.origin;
  } catch { /* falls through */ }
  throw new Error(`BOITE_APP_ORIGIN: expected an https origin such as ${APP_ORIGIN}, got ${named}`);
}

export interface ServerOptions {
  core: Core;
  host?: string;
  port?: number;
  helloTimeoutMs?: number;
  /**
   * A core in a group may answer on this machine's tailnet address through a
   * listener of its own. `main` turns it on unless `--host` or `--lan` chose
   * the address; a test core never opens a port outside loopback.
   */
  tailnet?: boolean;
}

export interface RunningServer {
  host: string;
  port: number;
  url: string;
  /** Sockets open now, relayed ones and the ones still saying hello included. */
  connections(): number;
  stop(): Promise<void>;
}

function envTimeout(): number | null {
  const raw = process.env.BOITE_HELLO_TIMEOUT_MS;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function isAllowedOrigin(origin: string | null, port: number, host: string): boolean {
  if (origin === null) return true;
  if (SHELL_ORIGINS.includes(origin)) return true;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin !== origin || Number(url.port || (url.protocol === 'https:' ? 443 : 80)) !== port) return false;
    const name = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (['127.0.0.1', 'localhost', '::1'].includes(name)) return true;
    if (host !== '0.0.0.0' && host !== '::') return name === host.toLowerCase();
    if (name === hostname().toLowerCase()) return true;
    return Object.values(networkInterfaces()).some((entries) => entries?.some((entry) => entry.address === name));
  } catch {
    return false;
  }
}

/** The socket came from a page whose origin names the host it asked for, outside loopback: this machine is served there. */
function servedOrigin(core: Core, origin: string | null, host: string | null): void {
  if (origin === null || host === null || SHELL_ORIGINS.includes(origin)) return;
  try {
    const url = new URL(origin);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin || url.host !== host.trim().toLowerCase()) return;
    if (isLoopbackHost(url.host)) return;
    core.group.servedFrom(origin);
  } catch {
    // Not an origin: nothing learned.
  }
}

/**
 * Who a stranger's request to a peer route is counted under, or null for one
 * never counted. Tailscale Funnel hands what it receives from the internet
 * over from loopback, marked `Tailscale-Funnel-Request` and with the sender in
 * `X-Forwarded-For`, both set by tailscaled whatever the sender wrote
 * (`contacts/funnel.ts`): those count under the sender. Other loopback
 * requests are this machine's own.
 */
export function strangerAddress(address: string | null, headers: Pick<Headers, 'get'>): string | null {
  if (address === null || !isLoopbackAddress(address)) return address;
  if (headers.get('tailscale-funnel-request') !== '?1') return null;
  return headers.get('x-forwarded-for')?.split(',').pop()?.trim() || 'funnel';
}

/**
 * What a socket waiting for hello is counted under: null for the owner's own
 * machine, which is never counted, else the peer address. The address comes
 * from the TCP connection and cannot be forged; a local tunnel or proxy
 * connects from loopback too but forwards a public `Host`, so its peers are
 * counted, all under the one loopback address.
 */
export function preauthPeer(address: string | null, host: string | null): string | null {
  if (isLoopbackAddress(address) && isLoopbackHost(host)) return null;
  return address ?? 'unknown';
}

/**
 * Why a socket from `peer` may not wait for its hello beside the `waiting`
 * ones, or null when it may. Peers behind a local tunnel share the loopback
 * address, which says nothing about who they are, so only the total bounds them.
 */
export function preauthRefusal(waiting: Iterable<string>, peer: string): string | null {
  let total = 0;
  let same = 0;
  for (const other of waiting) {
    total += 1;
    if (other === peer) same += 1;
  }
  if (total >= PREAUTH_SOCKETS_MAX) return `${total} sockets from other machines are already waiting for their hello`;
  if (!isLoopbackAddress(peer) && same >= PREAUTH_SOCKETS_PER_ADDRESS) {
    return `${same} sockets from ${peer} are already waiting for their hello`;
  }
  return null;
}

const IMMUTABLE_FOR_A_YEAR = 'public, max-age=31536000, immutable';
/**
 * Fonts and icons keep their names from one build to the next, so they cannot
 * be immutable. A day fresh, then a week served stale while the browser
 * revalidates: a font swapped in a release shows at most a day late, and the
 * revalidation is a 304.
 */
const FRESH_FOR_A_DAY = 'public, max-age=86400, stale-while-revalidate=604800';

/**
 * What the PWA's service worker needs from the host that serves it. Vite's
 * files under `/assets/` carry their content hash in their name, so the name
 * is the version and a phone never fetches one twice. The shell, the worker
 * and the manifest decide what the next load caches, so all three are
 * revalidated every time; `Service-Worker-Allowed` is what lets `/sw.js` claim
 * the whole origin rather than its own directory. Fonts and icons are fresh
 * for a day: a phone on the LAN has no service worker, since plain http is not
 * a secure context, and would otherwise fetch the default faces on every load.
 * Everything else keeps the headers `Bun.file` gives it.
 */
function cacheHeaders(pathname: string): Record<string, string> {
  if (pathname.startsWith('/assets/')) return { 'cache-control': IMMUTABLE_FOR_A_YEAR };
  if (pathname === '/sw.js') return { 'cache-control': 'no-cache', 'service-worker-allowed': '/' };
  if (pathname === '/' || pathname === '/index.html') return { 'cache-control': 'no-cache', ...NO_FOREIGN_FRAMES };
  if (pathname === '/manifest.webmanifest') return { 'cache-control': 'no-cache' };
  if (pathname.startsWith('/fonts/') || pathname.startsWith('/icons/')) return { 'cache-control': FRESH_FOR_A_DAY };
  return {};
}

/**
 * The page is the owner's whole UI, so no other site may frame it and lay a
 * decoy over Allow or Revoke. Ticketed files keep no such header: the panel
 * frames them, from the same origin in a browser.
 */
const NO_FOREIGN_FRAMES = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
} as const;

function staticFile(pathname: string): string | null {
  if (!existsSync(UI_DIST)) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(UI_DIST, relative));
  const root = resolve(UI_DIST);
  if (!resolve(full).startsWith(root + sep) && resolve(full) !== root) return null;
  return existsSync(full) ? full : null;
}

const ENCODINGS: readonly { token: string; suffix: string }[] = [
  { token: 'br', suffix: '.br' },
  { token: 'gzip', suffix: '.gz' },
];

/** The codings an `Accept-Encoding` value accepts. `br;q=0` names a coding to refuse it, so an entry at zero is not accepted. */
export function acceptedEncodings(acceptEncoding: string | null): string[] {
  return (acceptEncoding ?? '').toLowerCase().split(',').flatMap((entry) => {
    const [token = '', ...params] = entry.split(';').map((piece) => piece.trim());
    const quality = params.find((param) => param.startsWith('q='));
    return quality !== undefined && Number(quality.slice(2)) === 0 ? [] : [token];
  });
}

/**
 * The validators of the exact file sent, read at each request: the size and
 * the modification time, with the coding in the tag so the `.br` and the `.gz`
 * of one file never answer for each other. Stating the file every time costs
 * one system call and means a build replaced under a running core is never
 * answered with a 304 for the old one.
 */
function validators(path: string, coding: string | null): { etag: string; lastModified: string; modifiedSeconds: number } {
  const stats = statSync(path);
  const modifiedSeconds = Math.floor(stats.mtimeMs / 1000);
  return {
    etag: `"${stats.size.toString(36)}-${Math.floor(stats.mtimeMs).toString(36)}${coding === null ? '' : `-${coding}`}"`,
    lastModified: new Date(modifiedSeconds * 1000).toUTCString(),
    modifiedSeconds,
  };
}

/** RFC 9110: `If-None-Match` decides when present (weak comparison), `If-Modified-Since` only without it. */
function notModified(conditions: Pick<Headers, 'get'> | undefined, etag: string, modifiedSeconds: number): boolean {
  if (conditions === undefined) return false;
  const match = conditions.get('if-none-match');
  if (match !== null) {
    return match.split(',').some((tag) => {
      const trimmed = tag.trim();
      return trimmed === '*' || trimmed.replace(/^W\//, '') === etag;
    });
  }
  const since = conditions.get('if-modified-since');
  if (since === null) return false;
  const time = Date.parse(since);
  return Number.isFinite(time) && modifiedSeconds <= Math.floor(time / 1000);
}

/**
 * The UI build compresses its own text files (`packages/ui/vite.config.ts`),
 * so the core never deflates anything: it hands out the file the browser says
 * it can read. A browser only offers `br` on https, so a phone on the LAN gets
 * the `.gz`. `Vary` keeps a cache between the two from mixing them up. Every
 * answer outside `/assets/` carries an `ETag` and a `Last-Modified` of the
 * variant sent, so a revalidation of the shell, the worker or a font is a
 * bodiless 304.
 */
export function staticResponse(file: string, pathname: string, acceptEncoding: string | null, conditions?: Pick<Headers, 'get'>): Response {
  const accepted = acceptedEncodings(acceptEncoding);
  let sent = file;
  let coding: string | null = null;
  for (const { token, suffix } of ENCODINGS) {
    if (!accepted.includes(token)) continue;
    const candidate = file + suffix;
    if (!existsSync(candidate)) continue;
    sent = candidate;
    coding = token;
    break;
  }
  const headers: Record<string, string> = { ...cacheHeaders(pathname), vary: 'accept-encoding' };
  // A hashed asset is immutable, its name is its version: a validator would be about 70 bytes on every one, never used.
  if (!pathname.startsWith('/assets/')) {
    const { etag, lastModified, modifiedSeconds } = validators(sent, coding);
    headers.etag = etag;
    headers['last-modified'] = lastModified;
    if (notModified(conditions, etag, modifiedSeconds)) return new Response(null, { status: 304, headers });
  }
  if (coding === null) return new Response(Bun.file(file), { headers });
  return new Response(Bun.file(sent), { headers: { ...headers, 'content-type': Bun.file(file).type, 'content-encoding': coding } });
}

/**
 * A project's cards go where `todos.list` would answer: the owner, and an agent
 * whose thread belongs to that project. A paired device has no todo method, so
 * it gets no todo event either.
 */
function mayReadTodos(core: Core, connection: Connection, projectId: string): boolean {
  const identity = connection.identity;
  // A paired device is the user's, reading every project's threads and board as the owner does.
  if (identity.principal === 'owner' || identity.principal === 'session') return true;
  if (identity.principal !== 'agent' || identity.threadId === null) return false;
  try {
    return core.threads.require(identity.threadId).projectId === projectId;
  } catch {
    // The thread went away while its agent was still connected.
    return false;
  }
}

/**
 * `core.shutdown` for a caller with no WebSocket: the desktop shell before it
 * hands its files to the installer, the installer itself, and a shell that
 * found an older core than itself. Only the core token opens it, only through
 * a loopback name, so a proxy on this machine forwarding a public name cannot
 * reach it. The answer is 202: the process drains and exits after it.
 */
export const SHUTDOWN_PATH = '/shutdown';
export const IDLE_SHUTDOWN_PATH = '/shutdown-if-idle';
/** Stops without waiting for idle and hands the running turns to the next core. */
export const HANDOFF_SHUTDOWN_PATH = '/shutdown-for-update';

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function shutdownResponse(core: Core, request: Request, mode: 'now' | 'idle' | 'handoff' = 'now'): Response {
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: { allow: 'POST' } });
  if (!isLoopbackHost(request.headers.get('host'))) {
    return new Response('shutdown is only served on a loopback name', { status: 403 });
  }
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (token === '' || !sameToken(token, core.token)) {
    return new Response('shutdown needs "Authorization: Bearer <core token>" from core.json', { status: 401 });
  }
  if (mode !== 'now' && new URL(request.url).searchParams.get('pid') !== String(process.pid)) {
    return new Response('pid must name this core process', { status: 412 });
  }
  if (mode === 'handoff') {
    if (core.requestHandoffShutdown() === 'unsupported') return new Response('this embedded core has no process to stop', { status: 501 });
  } else if (mode === 'idle') {
    const admission = core.requestIdleShutdown();
    if (admission === 'busy') return new Response('active work prevents installation; retry after it finishes', { status: 409 });
    if (admission === 'unsupported') return new Response('this embedded core has no process to stop', { status: 501 });
  } else if (!core.requestShutdown()) return new Response('this embedded core has no process to stop', { status: 501 });
  return Response.json({ ok: true, pid: process.pid }, { status: 202 });
}

/**
 * The ports a core with none of its own tries first, ten per channel so an
 * installed app and a development core sit side by side. They are below
 * 49152: Windows lends 49152 to 65535 to outgoing connections and Hyper-V
 * reserves blocks of it at boot, so a random port from there can be taken by
 * the next start, and every phone paired with the old one is lost.
 */
export const PREFERRED_PORTS: Record<Channel, readonly number[]> = {
  stable: Array.from({ length: 10 }, (_, index) => 7337 + index),
  dev: Array.from({ length: 10 }, (_, index) => 7347 + index),
};

/**
 * The server of a core started from `main.ts`. A `--port` the operator named is
 * the only one tried, and a taken one is a loud error: a reverse proxy points
 * at it. Otherwise the port the previous run of this data directory bound, so a
 * paired phone and an installed PWA keep their origin across a restart, then
 * the channel's preferred ports, then a random one; a move is said in the log.
 */
export function startServerOnStickyPort(
  options: ServerOptions & { explicitPort: boolean; previousPort: number | null; preferredPorts?: readonly number[] },
): RunningServer {
  const { explicitPort, previousPort, preferredPorts = PREFERRED_PORTS[options.core.channel], ...server } = options;
  // Before any port is tried: a misspelt app address is no port taken.
  appOrigin();
  if (explicitPort) return startServer(server);
  const candidates = [...new Set([...(previousPort === null ? [] : [previousPort]), ...preferredPorts])];
  let last: unknown = null;
  for (const port of candidates) {
    try {
      const started = startServer({ ...server, port });
      if (previousPort !== null && port !== previousPort) server.core.log('warn', `port ${previousPort} of the previous run is taken, listening on ${port}`, { source: 'startup', event: 'startup.port-fallback', data: { previousPort, port } });
      return started;
    } catch (error) {
      last = error;
      if (port === previousPort) server.core.log('warn', `port ${previousPort} of the previous run is taken (${messageOf(error)})`, { source: 'startup', event: 'startup.port-taken', data: { previousPort } });
    }
  }
  // The last refusal is named: a host that cannot be bound fails every port the same way, which "taken" would hide.
  // The bound port is logged, not the 0 asked for; a host no port accepts is logged before it throws.
  let started: RunningServer;
  try { started = startServer({ ...server, port: 0 }); }
  catch (error) {
    server.core.log('warn', `ports ${candidates.join(', ')} refused the server (${messageOf(last)}), and so did any other port`, { source: 'startup', event: 'startup.port-fallback', data: { previousPort, port: null } });
    throw error;
  }
  server.core.log('warn', `ports ${candidates.join(', ')} refused the server (${messageOf(last)}), listening on ${started.port}`, { source: 'startup', event: 'startup.port-fallback', data: { previousPort, port: started.port } });
  return started;
}

export function startServer(options: ServerOptions): RunningServer {
  const core = options.core;
  const host = options.host ?? '127.0.0.1';
  const helloTimeoutMs = options.helloTimeoutMs ?? envTimeout() ?? DEFAULT_HELLO_TIMEOUT_MS;
  // Read once, before anything is set up: a misspelt override stops the start rather than letting a page nobody meant in.
  const app = appOrigin();
  const connections = new Set<ServerConnection>();
  const helloTimers = new Map<ServerConnection, ReturnType<typeof setTimeout>>();
  /** The counted peer of each open socket from another machine, until it closes. */
  const peers = new Map<ServerConnection, string>();
  function* waitingPeers(): Generator<string> {
    for (const [connection, peer] of peers) if (!connection.authenticated) yield peer;
    // A relayed socket waits for its hello under the same bounds.
    yield* relays.waitingPeers();
  }
  const frames = new Set<Promise<void>>();
  const incoming = new FrameQueue((connection, raw, signal) => handleFrame(core, connection, raw, signal), {
    refuse: refuseFrame,
    warn: message => core.logs.record('warn', message, { source: 'rpc', event: 'rpc.detached-refused' }),
  });
  const peerRequests = new Set<Promise<Response>>();
  const refusals = new Refusals();
  // A client of this machine carried to another member of its group: its key here, never an agent's, opens the way.
  const relays = new RelayHub(core, (credential) => {
    if (typeof credential !== 'string') {
      // A device of the group carried to another member: its signature for this machine, never one made for another.
      try { return { sessionId: core.group.clients.authenticateDevice(credential, { name: 'pwa', version: '' }).sessionId }; } catch { return null; }
    }
    const identity = authenticateToken(core, credential);
    return identity === null || identity.principal === 'agent' ? null : { sessionId: identity.sessionId };
  }, { helloTimeoutMs, helloMaxBytes: PREAUTH_FRAME_MAX_BYTES });
  core.relays = relays;
  let stopping = false;

  // One set of handlers for every address the core answers on: the sockets,
  // the hello bounds and the broadcast are the core's, not a listener's.
  const serve = (hostname: string, bind: number) => Bun.serve<SocketData | RelaySocketData | ContactSocketData>({
    hostname,
    port: bind,
    // HTTP only: the websocket block below keeps Bun's own 120 s and its pings.
    idleTimeout: HTTP_IDLE_TIMEOUT_S,

    fetch(request, self) {
      if (stopping) return new Response('core stopping', { status: 503 });
      const url = new URL(request.url);

      if (url.pathname === '/agent-messages' || url.pathname === JOIN_ROUTE || url.pathname === CONTACT_JOIN_ROUTE) {
        if (core.stopping) return new Response('core stopping', { status: 503 });
        // A stranger's requests are counted against its address from the moment they arrive, before any body is read.
        const address = strangerAddress(self.requestIP(request)?.address ?? null, request.headers);
        const answered = address === null ? () => undefined : refusals.begin(address);
        if (answered === null) return new Response('too many refused requests from this address', { status: 429 });
        const named = request.headers.get('x-boite-peer') ?? '';
        const response = (url.pathname === JOIN_ROUTE ? core.group.http(request) : url.pathname === CONTACT_JOIN_ROUTE ? core.contacts.http(request) : core.coordination.http(request)).then((answer) => {
          // Served means the signature of the machine the request names was checked: that address is this member's.
          answered(answer.status, named);
          return answer;
        }, (error: unknown) => {
          answered(403);
          throw error;
        });
        peerRequests.add(response);
        void response.finally(() => peerRequests.delete(response)).catch(() => undefined);
        return response;
      }

      // A contact's core keeps this socket open: this core's requests to it go down it (contacts/store.ts).
      if (url.pathname === CONTACT_LINK_ROUTE) {
        if (core.stopping) return new Response('core stopping', { status: 503 });
        const address = strangerAddress(self.requestIP(request)?.address ?? null, request.headers);
        const answered = address === null ? () => undefined : refusals.begin(address);
        if (answered === null) return new Response('too many refused requests from this address', { status: 429 });
        const verdict = core.contacts.hello(request);
        if (verdict instanceof Response) {
          answered(verdict.status);
          return verdict;
        }
        if (self.upgrade(request, { data: { contact: verdict } })) {
          answered(200, verdict.coreId);
          return undefined;
        }
        answered(400);
        return new Response('expected a websocket upgrade', { status: 400 });
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: core.version, pid: process.pid, bundleHash: core.bundleHash });
      }

      if (url.pathname === SHUTDOWN_PATH) return shutdownResponse(core, request);
      if (url.pathname === IDLE_SHUTDOWN_PATH) return shutdownResponse(core, request, 'idle');
      if (url.pathname === HANDOFF_SHUTDOWN_PATH) return shutdownResponse(core, request, 'handoff');

      // An agent session's MCP servers, behind its thread's token (mcp/lazy.ts).
      if (url.pathname.startsWith(LAZY_MCP_ROUTE)) {
        if (core.stopping) return new Response('core stopping', { status: 503 });
        return core.lazyMcp.http(request, url.pathname.slice(LAZY_MCP_ROUTE.length));
      }

      if (url.pathname.startsWith(`${FILE_ROUTE}/`)) {
        if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
        return ticketedFile(core, url.pathname.slice(FILE_ROUTE.length + 1), request.headers.get('range'));
      }

      if (url.pathname.startsWith(`${VIEW_ROUTE}/`)) {
        if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
        return viewPage(core, url.pathname.slice(VIEW_ROUTE.length + 1), acceptedEncodings(request.headers.get('accept-encoding')).includes('gzip'));
      }

      // What this machine trusts of its own accord: itself, the shell, and the addresses its owner gave it.
      const ownOrigin = (origin: string | null): boolean => isAllowedOrigin(origin, self.port ?? 0, hostname)
        || (origin !== null && (core.settings.get().browserOrigins?.includes(origin) === true || origin === core.settings.get().publicUrl));
      // A page served by one machine of the group opens its socket on the others.
      const allowedOrigin = (origin: string | null): boolean => ownOrigin(origin) || (origin !== null && (origin === app || core.group.allowsOrigin(origin)));

      const relayed = parseRelayPath(url.pathname);
      if (relayed !== null) {
        if (core.stopping) return new Response('core stopping', { status: 503 });
        return relays.http(request, relayed).then((answer) => {
          if (answer !== null) return answer;
          const origin = request.headers.get('origin');
          if (!allowedOrigin(origin)) {
            core.log('warn', `refused a relayed websocket from origin ${origin === null ? '(none)' : clientField(origin, 100)}`, { source: 'connections', event: 'connection.origin-refused' });
            return new Response('forbidden origin', { status: 403 });
          }
          const peer = preauthPeer(self.requestIP(request)?.address ?? null, request.headers.get('host'));
          const refusal = peer === null ? null : preauthRefusal(waitingPeers(), peer);
          if (refusal !== null) {
            core.log('warn', `refused a relayed websocket: ${refusal}`, { source: 'connections', event: 'connection.preauth-refused' });
            return new Response('too many connections waiting for hello', { status: 503 });
          }
          const encrypted = encryptedLink(self.requestIP(request)?.address ?? null, request.headers.get('host'), origin, request.headers.get(RELAYED_LINK_HEADER), tailnetAddress() !== null);
          const pipe = relays.pipe(relayed.coreId, peer, !isLoopbackHost(request.headers.get('host')), encrypted);
          if (self.upgrade(request, { data: { relay: pipe } })) return undefined;
          pipe.close(1000);
          return new Response('expected a websocket upgrade', { status: 400 });
        });
      }

      if (url.pathname === RPC_PATH) {
        const origin = request.headers.get('origin');
        if (!allowedOrigin(origin)) {
          core.log('warn', `refused a websocket from origin ${origin === null ? '(none)' : clientField(origin, 100)}`, { source: 'connections', event: 'connection.origin-refused' });
          return new Response('forbidden origin', { status: 403 });
        }
        const peer = preauthPeer(self.requestIP(request)?.address ?? null, request.headers.get('host'));
        const refusal = peer === null ? null : preauthRefusal(waitingPeers(), peer);
        if (refusal !== null) {
          core.log('warn', `refused a websocket: ${refusal}`, { source: 'connections', event: 'connection.preauth-refused' });
          return new Response('too many connections waiting for hello', { status: 503 });
        }
        // A page of this machine, at an origin it trusts itself and that names the host the socket asked for:
        // this machine is served there, and the others of its group accept that origin from now on. Learned
        // before any hello, so a phone's first page, which holds no key yet, already opens the way to the others.
        const connection = new ServerConnection(core, !isLoopbackHost(request.headers.get('host')));
        connection.encrypted = encryptedLink(self.requestIP(request)?.address ?? null, request.headers.get('host'), origin, request.headers.get(RELAYED_LINK_HEADER), tailnetAddress() !== null);
        if (self.upgrade(request, { data: { connection, peer } })) {
          // A page of this machine, at an origin it trusts itself and that names the host the socket asked for:
          // this machine is served there, and the others of its group accept that origin from now on. Learned at
          // the upgrade, before any hello, so a phone's first page, which holds no key yet, already opens the way.
          if (ownOrigin(origin)) servedOrigin(core, origin, request.headers.get('host'));
          return undefined;
        }
        return new Response('expected a websocket upgrade', { status: 400 });
      }

      const file = staticFile(url.pathname);
      if (file !== null) return staticResponse(file, url.pathname, request.headers.get('accept-encoding'), request.headers);
      if (url.pathname === '/') {
        return new Response(PLACEHOLDER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...NO_FOREIGN_FRAMES } });
      }
      return new Response('not found', { status: 404 });
    },

    websocket: {
      // The shared compressor, no window kept between frames. Bun 1.4.2's
      // per-socket window (`dedicated`, or any size) was measured on
      // 2026-09-19 and does no matching inside a frame: a 30 KB `threads.list`
      // left at 20.9 KB, against 1.6 KB here. What a kept window would have
      // saved on small delta frames is won back by pacing them
      // (`ServerConnection.sendEvent`). Whether a frame is deflated at all is
      // the connection's call, in `ServerConnection.write`.
      perMessageDeflate: true,
      // Bun closes the socket on a larger frame before any handler sees it.
      // The contract derives the attachment total of a turn from this number,
      // and the UI refuses a larger frame before sending it.
      maxPayloadLength: RPC_MAX_FRAME_BYTES,
      // Bun drops a frame, and keeps the socket open, once this much waits
      // (16 MiB by default). The connections and relays close at their own
      // 32 MiB budget first, checked before each send, so nothing is dropped
      // below the limit the code enforces.
      backpressureLimit: OUTBOUND_MAX_BUFFERED_BYTES,

      open(socket) {
        if ('contact' in socket.data) {
          core.contacts.attach(socket.data.contact, socket);
          return;
        }
        if ('relay' in socket.data) {
          socket.data.relay.attach(socket as ServerWebSocket<RelaySocketData>);
          return;
        }
        const connection = socket.data.connection;
        connection.attach(socket as ServerWebSocket<SocketData>);
        connections.add(connection);
        if (socket.data.peer !== null) peers.set(connection, socket.data.peer);
        helloTimers.set(connection, setTimeout(() => {
          helloTimers.delete(connection);
          if (connection.authenticated) return;
          connection.close(RpcCloseCode.Unauthorized, 'hello timed out');
        }, helloTimeoutMs));
      },

      message(socket, raw) {
        if (stopping) return;
        if ('contact' in socket.data) {
          core.contacts.frame(socket.data.contact, raw);
          return;
        }
        if ('relay' in socket.data) {
          socket.data.relay.receive(raw);
          return;
        }
        const connection = socket.data.connection;
        if (!connection.authenticated && raw.length > PREAUTH_FRAME_MAX_BYTES) {
          connection.close(RpcCloseCode.Unauthorized, 'hello frame too large');
          return;
        }
        const text = typeof raw === 'string' ? raw : raw.toString();
        // Hello remains immediate and bounded by the pre-auth frame limit.
        const frame = connection.authenticated ? incoming.enqueue(connection, text) : handleFrame(core, connection, text);
        frames.add(frame);
        void frame.catch((error: unknown) => core.log('error', messageOf(error))).finally(() => frames.delete(frame));
      },

      drain(socket) {
        if ('contact' in socket.data) return;
        if ('relay' in socket.data) socket.data.relay.drained();
        else socket.data.connection.drain();
      },

      close(socket, code, reason) {
        if ('contact' in socket.data) {
          core.contacts.detach(socket.data.contact);
          return;
        }
        if ('relay' in socket.data) {
          socket.data.relay.close(1000, 'client closed');
          return;
        }
        logConnectionClosed(core, socket.data.connection, code, reason);
        core.procs.unwatchResources(socket.data.connection.id);
        core.coordination.bridge.disconnect(socket.data.connection.id);
        core.browser.disconnect(socket.data.connection.id);
        core.terminals.disconnect(socket.data.connection.id);
        core.threads.focus.disconnect(socket.data.connection.id);
        void core.drafts.disconnect(socket.data.connection.id).catch(error => core.log('warn', `draft cleanup failed: ${String(error)}`));
        void core.attachmentUploads.disconnect(socket.data.connection.id).catch(error => core.log('warn', `attachment cleanup failed: ${String(error)}`));
        incoming.drop(socket.data.connection);
        socket.data.connection.close(1000);
        clearTimeout(helloTimers.get(socket.data.connection));
        helloTimers.delete(socket.data.connection);
        connections.delete(socket.data.connection);
        peers.delete(socket.data.connection);
      },
    },
  });
  const server = serve(host, options.port ?? 0);

  const port = server.port ?? 0;
  core.setEndpoint(host, port);
  const everywhere = host === '0.0.0.0' || host === '::';
  let extra: { host: string; server: ReturnType<typeof serve> } | null = null;
  let refused: string | null = null;
  const closeExtra = (): void => {
    // As for the main listener: `stop()` never resolves once a socket was upgraded.
    if (extra !== null) void extra.server.stop(true);
    extra = null;
  };
  core.network = {
    also(address: string | null): boolean {
      if (stopping) return false;
      // An admin policy without groups leaves nothing for the group to reach.
      if (address === null || everywhere || address === host || options.tailnet !== true || core.policy.networkOff('groups')) {
        closeExtra();
        return address !== null && (everywhere || address === host);
      }
      if (extra?.host === address) return true;
      closeExtra();
      try {
        extra = { host: address, server: serve(address, port) };
        refused = null;
        core.log('info', `listening on ${address}:${port} too, for the machines of this core's group`);
        return true;
      } catch (error) {
        // Asked again at every tick while the address stays unusable: say it once.
        if (refused !== address) core.log('warn', `could not listen on ${address}:${port} for the group: ${messageOf(error)}`);
        refused = address;
        return false;
      }
    },
  };
  // What a restart handed over starts once agents can reach this core. After
  // the caller's own setup: `main` writes `core.json` right behind this call.
  setTimeout(() => {
    if (stopping) return;
    // A provider told from another by its program's version is not installed,
    // as far as a turn is concerned, until that program has answered: on the
    // first start after an update there is no kept reading, and a turn resumed
    // before it would be refused for good.
    void core.providers.settle().finally(() => {
      if (stopping) return;
      core.threads.handoff.resume();
      // The children and steps the handoff cut go on with their conversations.
      core.delegation.resumeAfterRestart();
      core.workflows.resumeAfterRestart();
    });
    // Desktop-app plugins the owner left enabled, now that they have an address to reach.
    core.plugins.startApps();
    // Newer releases of installed recommended plugins, read a minute from now and every six hours.
    core.plugins.startUpdateChecks();
  }, 0);
  core.subscribers = {
    hasSubscribers(threadId: ThreadId): boolean {
      for (const connection of connections) {
        // Only a window counts: an agent or a desktop-app plugin following the
        // thread (B.O.T.S streams every thread at work) shows it to nobody.
        if (!connection.authenticated || connection.identity.principal === 'agent' || connection.clientName === 'plugin') continue;
        if (connection.subscriptions.has(threadId)) return true;
      }
      return false;
    },
    closeSession(sessionId: string): void {
      for (const connection of connections) {
        if (connection.identity.sessionId === sessionId) connection.close(RpcCloseCode.Unauthorized, 'session revoked');
      }
      relays.closeSession(sessionId);
    },
    closeAgents(threadId: ThreadId): void {
      for (const connection of connections) {
        const identity = connection.identity;
        if (identity.principal === 'agent' && identity.threadId === threadId) {
          connection.close(RpcCloseCode.Unauthorized, 'thread archived or removed');
        }
      }
    },
    reveal(target): number {
      // Owner windows only: a paired phone or an agent has no window of the owner's
      // to raise, and a desktop-app plugin, often the caller itself, draws none of Boite's.
      let delivered = 0;
      for (const connection of connections) {
        if (!connection.authenticated || connection.identity.principal !== 'owner' || connection.clientName === 'plugin') continue;
        try { connection.sendEvent('ui.reveal', { target }); delivered += 1; } catch { /* closing */ }
      }
      return delivered;
    },
  };

  const broadcast = (name: RpcEventName, payload: EventPayload): void => {
    // These invalidations belong to explicit association watches, never the global bus.
    if (name === 'sharedProjects.changed') return;
    const scoped =
      name === 'threads.pullRequestsChanged' ||
      name.startsWith('message.') ||
      name.startsWith('permission.') ||
      name.startsWith('question.') ||
      // A panel request is for the clients watching that thread: a second
      // window on another thread must not have its panel taken over.
      name.startsWith('panel.') ||
      // Whether that thread's shared browser tab exists.
      name === 'browser.remoteChanged' ||
      // That thread's Device panel sessions.
      name === 'devices.changed' ||
      // That thread's Window panel.
      name === 'windows.changed' ||
      // Every grandchild's record, command line included: only that thread's
      // trace panel reads it.
      name.startsWith('process.');
    const threadId = eventThreadId(payload);
    // A child's question or permission is also for the windows that have its parent open:
    // children are no sidebar rows, so the parent is where the user meets them.
    const parentId = threadId !== null && (name.startsWith('question.') || name.startsWith('permission.'))
      ? core.journal.getThread(threadId)?.parentThreadId ?? null
      : null;
    // Agent conversations draw their hidden session's cards without opening
    // its transcript. They need both new questions and their resolution.
    const agentQuestion = threadId !== null && name.startsWith('question.') && !!core.journal.getThread(threadId)?.agentSessionId;
    const loadRow = name === 'thread.load' ? loadRowSender(core, payload as RpcEvents['thread.load']) : null;
    // Serialized once per projection, not once per socket.
    const frames: EventFrames = new Map();
    for (const connection of connections) {
      if (!connection.authenticated) continue;
      if (!mayReceiveEvent(name, connection)) continue;
      if (connection.identity.principal === 'agent' && !agentHearsEvent(name, payload, connection.identity.threadId, id => core.journal.getThread(id)?.projectId ?? null)) continue;
      if (SUBSCRIBED_EVENTS.has(name) && !connection.subscriptions.has(threadId ?? '')) continue;
      if (scoped && !agentQuestion && (threadId === null || !(connection.subscriptions.has(threadId) || (parentId !== null && connection.subscriptions.has(parentId))))) continue;
      // The whole activity, loop history included, is for the clients that have
      // that thread open; an agent socket still gets its own thread's.
      if (name === 'thread.activity' && connection.identity.principal !== 'agent' && (threadId === null || !connection.subscriptions.has(threadId))) continue;
      if (name === 'todos.updated' && !mayReadTodos(core, connection, (payload as RpcEvents['todos.updated']).projectId)) continue;
      if (name === 'todos.updated' && connection.identity.principal === 'agent') {
        const event = payload as RpcEvents['todos.updated'];
        if (connection.identity.threadId === null) continue;
        // Local cards stay readable when remote coordination/model policy closes the shared projection.
        connection.sendEvent(name, {...event, todos: core.sharedBoard.visibleTodos(connection.identity.threadId, event.todos, connection)});
        continue;
      }
      // A shell's bytes go to the windows that attached it. Its exit still goes to every owner window: one
      // that lays the pane out without having attached it, a background tab say, drops the pane then.
      if (name === 'terminal.output' && !core.terminals.watches((payload as RpcEvents['terminal.output']).id, connection.id)) continue;
      if (loadRow && !connection.accepts.has('thread.load')) { loadRow(connection); continue; }
      connection.sendEvent(name, payload, frames);
    }
    if (name === 'terminal.exited') core.terminals.exitSent((payload as RpcEvents['terminal.exited']).id);
  };
  let pendingScheduler: RpcEvents['scheduler.updated'] | null = null;
  let schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  const off = core.bus.onCommitted((name, payload) => {
    if (name !== 'scheduler.updated') {
      broadcast(name, payload);
      return;
    }
    // A thousand queued turns used to serialize and compress every intermediate
    // queue for every reader. Only the newest snapshot in this window is useful.
    pendingScheduler = payload as RpcEvents['scheduler.updated'];
    schedulerTimer ??= setTimeout(() => {
      schedulerTimer = null;
      const latest = pendingScheduler;
      pendingScheduler = null;
      if (latest !== null) broadcast('scheduler.updated', latest);
    }, SCHEDULER_WINDOW_MS);
  });

  core.group.start();
  core.contacts.start();

  return {
    host,
    port,
    url: core.baseUrl(),
    // Relayed sockets too, those still waiting for their hello included.
    connections: () => connections.size + relays.size,
    async stop(): Promise<void> {
      stopping = true;
      incoming.close();
      off();
      if (schedulerTimer !== null) clearTimeout(schedulerTimer);
      schedulerTimer = null;
      pendingScheduler = null;
      for (const timer of helloTimers.values()) clearTimeout(timer);
      helloTimers.clear();
      for (const connection of connections) connection.close(1001, 'core stopping');
      connections.clear();
      relays.closeAll();
      peers.clear();
      // Bun 1.3.11 never resolves server.stop() once a socket has been upgraded,
      // so the listener is closed without waiting on that promise.
      void server.stop(true);
      closeExtra();
      await Promise.allSettled([...frames, ...peerRequests]);
    },
  };
}
