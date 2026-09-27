import type { RpcEvents, ThreadId } from '@boite/contracts';
import { FILE_ROUTE, RPC_MAX_FRAME_BYTES, RPC_PATH, RpcCloseCode } from '@boite/contracts';
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import { eventThreadId } from './bus.ts';
import { mayReceiveEvent } from './access.ts';
import type { Core } from './core.ts';
import { messageOf } from './errors.ts';
import type { Connection } from './router.ts';
import type { SocketData } from './server/connection.ts';
import { ServerConnection } from './server/connection.ts';
import { handleFrame } from './server/frame.ts';
export { ServerConnection } from './server/connection.ts';

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

export interface ServerOptions {
  core: Core;
  host?: string;
  port?: number;
  helloTimeoutMs?: number;
}

export interface RunningServer {
  host: string;
  port: number;
  url: string;
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
 * What the PWA's service worker needs from the host that serves it. Vite's
 * files under `/assets/` carry their content hash in their name, so the name
 * is the version and a phone never fetches one twice. The shell, the worker
 * and the manifest decide what the next load caches, so all three are
 * revalidated every time; `Service-Worker-Allowed` is what lets `/sw.js` claim
 * the whole origin rather than its own directory. Everything else keeps the
 * headers `Bun.file` gives it.
 */
function cacheHeaders(pathname: string): Record<string, string> {
  if (pathname.startsWith('/assets/')) return { 'cache-control': IMMUTABLE_FOR_A_YEAR };
  if (pathname === '/sw.js') return { 'cache-control': 'no-cache', 'service-worker-allowed': '/' };
  if (pathname === '/' || pathname === '/index.html') return { 'cache-control': 'no-cache', ...NO_FOREIGN_FRAMES };
  if (pathname === '/manifest.webmanifest') return { 'cache-control': 'no-cache' };
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

/**
 * The UI build compresses its own text files (`packages/ui/vite.config.ts`),
 * so the core never deflates anything: it hands out the file the browser says
 * it can read. A browser only offers `br` on https, so a phone on the LAN gets
 * the `.gz`. `Vary` keeps a cache between the two from mixing them up.
 */
export function staticResponse(file: string, pathname: string, acceptEncoding: string | null): Response {
  const headers = cacheHeaders(pathname);
  // `br;q=0` names a coding to refuse it, so an entry at zero is not accepted.
  const accepted = (acceptEncoding ?? '').toLowerCase().split(',').flatMap((entry) => {
    const [token = '', ...params] = entry.split(';').map((piece) => piece.trim());
    const quality = params.find((param) => param.startsWith('q='));
    return quality !== undefined && Number(quality.slice(2)) === 0 ? [] : [token];
  });
  for (const { token, suffix } of ENCODINGS) {
    if (!accepted.includes(token)) continue;
    const candidate = file + suffix;
    if (!existsSync(candidate)) continue;
    return new Response(Bun.file(candidate), {
      headers: { ...headers, 'content-type': Bun.file(file).type, 'content-encoding': token, vary: 'accept-encoding' },
    });
  }
  return new Response(Bun.file(file), { headers: { ...headers, vary: 'accept-encoding' } });
}

/**
 * A project's cards go where `todos.list` would answer: the owner, and an agent
 * whose thread belongs to that project. A paired device has no todo method, so
 * it gets no todo event either.
 */
function mayReadTodos(core: Core, connection: Connection, projectId: string): boolean {
  const identity = connection.identity;
  if (identity.principal === 'owner') return true;
  if (identity.principal !== 'agent' || identity.threadId === null) return false;
  try {
    return core.threads.require(identity.threadId).projectId === projectId;
  } catch {
    // The thread went away while its agent was still connected.
    return false;
  }
}

/**
 * The file a ticket opens: what `files.read` could not put in a JSON frame.
 * The ticket is the whole address, so no request here names a path and no
 * answer says what an unknown one missed. A `Range` is honoured because that
 * is how a video seeks, and nothing is cached because the ticket outlives
 * neither the ten minutes nor the next write to the file.
 */
function ticketedFile(core: Core, ticket: string, range: string | null): Response {
  const target = core.fileTickets.resolve(ticket);
  if (target === null || !existsSync(target.path)) return new Response('unknown or expired ticket', { status: 404 });
  const file = Bun.file(target.path);
  const size = file.size;
  const headers: Record<string, string> = {
    'content-type': target.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    // The type is the one the extension named and nothing the bytes suggest,
    // and a ticket opened as a page downloads instead of rendering: an agent
    // picks what the panel opens, so no file of its may run in a window.
    // Neither header touches an <img> or a <video> loading the same address.
    'x-content-type-options': 'nosniff',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(target.path))}`,
  };
  const asked = range === null ? null : /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (asked === null) return new Response(file, { headers });

  const from = asked[1] ?? '';
  const to = asked[2] ?? '';
  const start = from.length > 0 ? Number(from) : Math.max(0, size - Number(to));
  const end = from.length === 0 ? size - 1 : to.length > 0 ? Math.min(Number(to), size - 1) : size - 1;
  if ((from.length === 0 && to.length === 0) || !Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response('range not satisfiable', { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
  }
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) },
  });
}

/**
 * `core.shutdown` for a caller with no WebSocket: the desktop shell before it
 * hands its files to the installer, the installer itself, and a shell that
 * found an older core than itself. Only the core token opens it, only through
 * a loopback name, so a proxy on this machine forwarding a public name cannot
 * reach it. The answer is 202: the process drains and exits after it.
 */
export const SHUTDOWN_PATH = '/shutdown';

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function shutdownResponse(core: Core, request: Request): Response {
  if (request.method !== 'POST') return new Response('POST only', { status: 405, headers: { allow: 'POST' } });
  if (!isLoopbackHost(request.headers.get('host'))) {
    return new Response('shutdown is only served on a loopback name', { status: 403 });
  }
  const header = request.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (token === '' || !sameToken(token, core.token)) {
    return new Response('shutdown needs "Authorization: Bearer <core token>" from core.json', { status: 401 });
  }
  if (!core.requestShutdown()) return new Response('this embedded core has no process to stop', { status: 501 });
  return Response.json({ ok: true, pid: process.pid }, { status: 202 });
}

/**
 * The server of a core started from `main.ts`. A `--port` the operator named is
 * the only one tried, and a taken one is a loud error: a reverse proxy points
 * at it. Otherwise the port the previous run of this data directory bound, so a
 * paired phone and an installed PWA keep their origin across a restart; when
 * another program took it meanwhile, a random one, said in the log.
 */
export function startServerOnStickyPort(
  options: ServerOptions & { explicitPort: boolean; previousPort: number | null },
): RunningServer {
  const { explicitPort, previousPort, ...server } = options;
  if (explicitPort || previousPort === null) return startServer(server);
  try {
    return startServer({ ...server, port: previousPort });
  } catch (error) {
    server.core.log('warn', `port ${previousPort} of the previous run is taken (${messageOf(error)}), listening on another`);
    return startServer({ ...server, port: 0 });
  }
}

export function startServer(options: ServerOptions): RunningServer {
  const core = options.core;
  const host = options.host ?? '127.0.0.1';
  const helloTimeoutMs = options.helloTimeoutMs ?? envTimeout() ?? DEFAULT_HELLO_TIMEOUT_MS;
  const connections = new Set<ServerConnection>();
  const helloTimers = new Map<ServerConnection, ReturnType<typeof setTimeout>>();
  /** The counted peer of each open socket from another machine, until it closes. */
  const peers = new Map<ServerConnection, string>();
  function* waitingPeers(): Generator<string> {
    for (const [connection, peer] of peers) if (!connection.authenticated) yield peer;
  }
  const frames = new Set<Promise<void>>();
  const peerRequests = new Set<Promise<Response>>();
  let stopping = false;

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port ?? 0,
    // HTTP only: the websocket block below keeps Bun's own 120 s and its pings.
    idleTimeout: HTTP_IDLE_TIMEOUT_S,

    fetch(request, self) {
      if (stopping) return new Response('core stopping', { status: 503 });
      const url = new URL(request.url);

      if (url.pathname === '/agent-messages') {
        const response = core.coordination.http(request);
        peerRequests.add(response);
        void response.finally(() => peerRequests.delete(response)).catch(() => undefined);
        return response;
      }

      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: core.version, pid: process.pid });
      }

      if (url.pathname === SHUTDOWN_PATH) return shutdownResponse(core, request);

      if (url.pathname.startsWith(`${FILE_ROUTE}/`)) {
        if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
        return ticketedFile(core, url.pathname.slice(FILE_ROUTE.length + 1), request.headers.get('range'));
      }

      if (url.pathname === RPC_PATH) {
        const origin = request.headers.get('origin');
        if (!isAllowedOrigin(origin, self.port ?? 0, host) && !(origin !== null && (core.settings.get().browserOrigins?.includes(origin) || origin === core.settings.get().publicUrl))) {
          core.log('warn', `refused a websocket from origin ${origin ?? '(none)'}`);
          return new Response('forbidden origin', { status: 403 });
        }
        const peer = preauthPeer(self.requestIP(request)?.address ?? null, request.headers.get('host'));
        const refusal = peer === null ? null : preauthRefusal(waitingPeers(), peer);
        if (refusal !== null) {
          core.log('warn', `refused a websocket: ${refusal}`);
          return new Response('too many connections waiting for hello', { status: 503 });
        }
        const connection = new ServerConnection(core, !isLoopbackHost(request.headers.get('host')));
        if (self.upgrade(request, { data: { connection, peer } })) return undefined;
        return new Response('expected a websocket upgrade', { status: 400 });
      }

      const file = staticFile(url.pathname);
      if (file !== null) return staticResponse(file, url.pathname, request.headers.get('accept-encoding'));
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

      open(socket) {
        const connection = socket.data.connection;
        connection.attach(socket);
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
        const connection = socket.data.connection;
        if (!connection.authenticated && raw.length > PREAUTH_FRAME_MAX_BYTES) {
          connection.close(RpcCloseCode.Unauthorized, 'hello frame too large');
          return;
        }
        const frame = handleFrame(core, socket.data.connection, typeof raw === 'string' ? raw : raw.toString());
        frames.add(frame);
        void frame.catch((error: unknown) => core.log('error', messageOf(error))).finally(() => frames.delete(frame));
      },

      drain(socket) { socket.data.connection.drain(); },

      close(socket) {
        core.speech.cancel(socket.data.connection.id);
        clearTimeout(helloTimers.get(socket.data.connection));
        helloTimers.delete(socket.data.connection);
        connections.delete(socket.data.connection);
        peers.delete(socket.data.connection);
      },
    },
  });

  const port = server.port ?? 0;
  core.setEndpoint(host, port);
  core.subscribers = {
    hasSubscribers(threadId: ThreadId): boolean {
      for (const connection of connections) {
        if (connection.authenticated && connection.subscriptions.has(threadId)) return true;
      }
      return false;
    },
    closeSession(sessionId: string): void {
      for (const connection of connections) {
        if (connection.identity.sessionId === sessionId) connection.close(RpcCloseCode.Unauthorized, 'session revoked');
      }
    },
    closeAgents(threadId: ThreadId): void {
      for (const connection of connections) {
        const identity = connection.identity;
        if (identity.principal === 'agent' && identity.threadId === threadId) {
          connection.close(RpcCloseCode.Unauthorized, 'thread archived or removed');
        }
      }
    },
  };

  const off = core.bus.onAny((name, payload) => {
    const scoped =
      name.startsWith('message.') ||
      name.startsWith('permission.') ||
      name.startsWith('question.') ||
      // A panel request is for the clients watching that thread: a second
      // window on another thread must not have its panel taken over.
      name.startsWith('panel.') ||
      // Every grandchild's record, command line included: only that thread's
      // trace panel reads it.
      name.startsWith('process.');
    const threadId = eventThreadId(payload);
    for (const connection of connections) {
      if (!connection.authenticated) continue;
      if (!mayReceiveEvent(name, connection)) continue;
      if (connection.identity.principal === 'agent' && name !== 'todos.updated' && name !== 'agents.changed' && connection.identity.threadId !== threadId) continue;
      if ((name === 'collaboration.changed' || name === 'delegation.changed' || name === 'workflows.changed') && !connection.subscriptions.has(threadId ?? '')) continue;
      if (scoped && (threadId === null || !connection.subscriptions.has(threadId))) continue;
      // The whole activity, loop history included, is for the clients that have
      // that thread open; an agent socket still gets its own thread's.
      if (name === 'thread.activity' && connection.identity.principal !== 'agent' && (threadId === null || !connection.subscriptions.has(threadId))) continue;
      if (name === 'todos.updated' && !mayReadTodos(core, connection, (payload as RpcEvents['todos.updated']).projectId)) continue;
      connection.sendEvent(name, payload);
    }
  });

  return {
    host,
    port,
    url: core.baseUrl(),
    async stop(): Promise<void> {
      stopping = true;
      off();
      for (const timer of helloTimers.values()) clearTimeout(timer);
      helloTimers.clear();
      for (const connection of connections) connection.close(1001, 'core stopping');
      connections.clear();
      peers.clear();
      // Bun 1.3.11 never resolves server.stop() once a socket has been upgraded,
      // so the listener is closed without waiting on that promise.
      void server.stop(true);
      await Promise.allSettled([...frames, ...peerRequests]);
    },
  };
}
