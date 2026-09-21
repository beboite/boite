import { existsSync } from 'node:fs';
import { hostname, networkInterfaces } from 'node:os';
import { basename, dirname, join, normalize, resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { FILE_ROUTE, PROTOCOL_VERSION, RPC_PATH, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import type { RpcError, RpcEventName, RpcEvents, ThreadId } from '@boite/contracts';
import { eventThreadId } from './bus.ts';
import type { Core } from './core.ts';
import { RpcFailure, messageOf } from './errors.ts';
import { newId } from './ids.ts';
import type { Connection } from './router.ts';
import { principalOf } from './sessions.ts';
import type { Identity } from './sessions.ts';

const DEFAULT_HELLO_TIMEOUT_MS = 5000;
const REMOTE_DELTA_WINDOW_MS = 80;
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

interface SocketData {
  connection: ServerConnection;
}

interface OutgoingResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: RpcError;
}

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

export class ServerConnection implements Connection {
  readonly id = newId('con_');
  readonly subscriptions = new Set<ThreadId>();
  authenticated = false;
  /** Owner until hello says otherwise; nothing reads it before `authenticated` is true. */
  identity: Identity = { principal: 'owner', sessionId: null, threadId: null };

  private socket: ServerWebSocket<SocketData> | null = null;
  private congested = false;
  private readonly catchUp = new Set<string>();
  private readonly paced = new Map<string, RpcEvents['message.delta']>();
  private paceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * `remote` is a client that reached the core by a name other than this
   * machine's loopback: a phone, a laptop, a tunnel. Its frames are deflated
   * and its deltas paced; the shell on 127.0.0.1 gets neither, because there
   * the bytes are free and the CPU is not.
   */
  constructor(private readonly core: Core, readonly remote = false) {}

  attach(socket: ServerWebSocket<SocketData>): void {
    this.socket = socket;
  }

  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'message.delta' && this.remote && !this.congested) {
      this.pace(payload as RpcEvents['message.delta']);
      return;
    }
    this.flushPaced();
    this.sendNow(name, payload);
  }

  /**
   * A remote client gets its text every `REMOTE_DELTA_WINDOW_MS` rather than
   * every 16 ms. Each frame costs its envelope, its ids and the headers under
   * it whatever text it carries, so five deltas in one frame are a fifth of
   * the bytes, and the UI only re-renders a paragraph once it closes. Any
   * other frame on this socket, an event or a response, sends what is held
   * first: a client never sees a card, or a snapshot, before the text that
   * came before it.
   */
  private pace(delta: RpcEvents['message.delta']): void {
    const key = `${delta.messageId}|${delta.partIndex}`;
    const held = this.paced.get(key);
    if (held) held.text += delta.text;
    else this.paced.set(key, { ...delta });
    this.paceTimer ??= setTimeout(() => this.flushPaced(), REMOTE_DELTA_WINDOW_MS);
  }

  private flushPaced(): void {
    if (this.paceTimer !== null) {
      clearTimeout(this.paceTimer);
      this.paceTimer = null;
    }
    if (this.paced.size === 0) return;
    const held = [...this.paced.values()];
    this.paced.clear();
    for (const delta of held) this.sendNow('message.delta', delta);
  }

  private sendNow<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'message.delta' && this.congested) {
      this.queueCatchUp(payload);
      return;
    }
    const sent = this.write({ jsonrpc: '2.0', method: name, params: payload });
    if (sent > 0) return;
    if (sent === 0) {
      this.close(1013, 'connection dropped a frame; reconnect');
      return;
    }
    this.congested = true;
    if (name === 'message.delta') this.queueCatchUp(payload);
  }

  sendResponse(response: OutgoingResponse): void {
    this.flushPaced();
    if (this.write(response) === 0) this.close(1013, 'connection dropped a response; reconnect');
  }

  close(code: number, reason?: string): void {
    this.core.speech.cancel(this.id);
    if (this.paceTimer !== null) clearTimeout(this.paceTimer);
    this.paceTimer = null;
    this.paced.clear();
    this.catchUp.clear();
    this.socket?.close(code, reason);
  }

  bufferedAmount(): number {
    return this.socket?.getBufferedAmount() ?? 0;
  }

  private write(frame: unknown): number {
    if (this.socket === null) return 0;
    return this.socket.send(JSON.stringify(frame), this.remote);
  }

  /** Backpressure: deltas are dropped, then the whole part is resent once the socket drains. */
  private queueCatchUp(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const messageId = (payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string') return;
    this.catchUp.add(messageId);
  }

  drain(): void {
    if (this.core.journal.isClosed()) return;
    this.core.journal.flushDeltas();
    this.congested = false;
    const ids = [...this.catchUp];
    for (const messageId of ids) {
      const message = this.core.journal.getMessage(messageId);
      if (message === null) { this.catchUp.delete(messageId); continue; }
      for (const [partIndex, part] of message.parts.entries()) {
        const sent = this.write({
          jsonrpc: '2.0',
          method: 'message.part',
          params: { threadId: message.threadId, messageId, partIndex, part },
        });
        if (sent === 0) { this.close(1013, 'catch-up dropped; reconnect'); return; }
        if (sent < 0) { this.congested = true; return; }
      }
      this.catchUp.delete(messageId);
    }
  }
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
  if (pathname === '/' || pathname === '/index.html' || pathname === '/manifest.webmanifest') {
    return { 'cache-control': 'no-cache' };
  }
  return {};
}

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

export function startServer(options: ServerOptions): RunningServer {
  const core = options.core;
  const host = options.host ?? '127.0.0.1';
  const helloTimeoutMs = options.helloTimeoutMs ?? envTimeout() ?? DEFAULT_HELLO_TIMEOUT_MS;
  const connections = new Set<ServerConnection>();
  const helloTimers = new Map<ServerConnection, ReturnType<typeof setTimeout>>();
  const frames = new Set<Promise<void>>();
  const peerRequests = new Set<Promise<Response>>();
  let stopping = false;

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port ?? 0,
    idleTimeout: 0,

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
        const connection = new ServerConnection(core, !isLoopbackHost(request.headers.get('host')));
        if (self.upgrade(request, { data: { connection } })) return undefined;
        return new Response('expected a websocket upgrade', { status: 400 });
      }

      const file = staticFile(url.pathname);
      if (file !== null) return staticResponse(file, url.pathname, request.headers.get('accept-encoding'));
      if (url.pathname === '/') {
        return new Response(PLACEHOLDER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
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

      open(socket) {
        const connection = socket.data.connection;
        connection.attach(socket);
        connections.add(connection);
        helloTimers.set(connection, setTimeout(() => {
          helloTimers.delete(connection);
          if (connection.authenticated) return;
          connection.close(RpcCloseCode.Unauthorized, 'hello timed out');
        }, helloTimeoutMs));
      },

      message(socket, raw) {
        if (stopping) return;
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
  };

  const off = core.bus.onAny((name, payload) => {
    const scoped =
      name.startsWith('message.') ||
      name.startsWith('permission.') ||
      name.startsWith('question.') ||
      // A panel request is for the clients watching that thread: a second
      // window on another thread must not have its panel taken over.
      name.startsWith('panel.');
    const threadId = eventThreadId(payload);
    for (const connection of connections) {
      if (!connection.authenticated) continue;
      if (name === 'collaboration.changed' && connection.identity.principal === 'agent' && connection.identity.threadId !== threadId) continue;
      if (name === 'collaboration.changed' && !connection.subscriptions.has(threadId ?? '')) continue;
      if (scoped && (threadId === null || !connection.subscriptions.has(threadId))) continue;
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
      // Bun 1.3.11 never resolves server.stop() once a socket has been upgraded,
      // so the listener is closed without waiting on that promise.
      void server.stop(true);
      await Promise.allSettled([...frames, ...peerRequests]);
    },
  };
}

async function handleFrame(core: Core, connection: ServerConnection, raw: string): Promise<void> {
  let frame: { id?: unknown; method?: unknown; params?: unknown };
  try {
    frame = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: unknown };
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('expected an RPC object');
  } catch {
    connection.sendResponse({
      jsonrpc: '2.0',
      id: 0,
      error: { code: RpcErrorCode.ParseError, message: 'the frame is not JSON' },
    });
    return;
  }

  const id = typeof frame.id === 'number' || typeof frame.id === 'string' ? frame.id : 0;
  const method = typeof frame.method === 'string' ? frame.method : '';

  if (!connection.authenticated) {
    if (method !== 'hello') {
      connection.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: RpcErrorCode.Unauthorized, message: 'the first frame must be hello' },
      });
      connection.close(RpcCloseCode.Unauthorized, 'hello expected');
      return;
    }
    const params = frame.params as
      | { token?: unknown; grant?: unknown; protocolVersion?: unknown; client?: { name?: unknown; version?: unknown } }
      | undefined;
    const refuse = (message: string, reason: string): void => {
      connection.sendResponse({ jsonrpc: '2.0', id, error: { code: RpcErrorCode.Unauthorized, message } });
      connection.close(RpcCloseCode.Unauthorized, reason);
    };
    const token = typeof params?.token === 'string' ? params.token : null;
    const grant = typeof params?.grant === 'string' ? params.grant : null;
    const client = {
      name: typeof params?.client?.name === 'string' ? params.client.name : 'unknown',
      version: typeof params?.client?.version === 'string' ? params.client.version : '',
    };

    let session: ReturnType<typeof core.sessions.exchange> | undefined;
    let identity: Identity;
    if (grant !== null && token === null) {
      // The exchange happens before the protocol check on purpose: a grant is
      // one-shot, and a client that trips the version check keeps its link.
      if (params?.protocolVersion !== PROTOCOL_VERSION) {
        connection.sendResponse({ jsonrpc: '2.0', id, error: {
          code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION}`,
        } });
        connection.close(RpcCloseCode.ProtocolMismatch, 'protocol version mismatch');
        return;
      }
      try {
        session = core.sessions.exchange(grant, client);
      } catch (error) {
        refuse(messageOf(error), 'bad grant');
        return;
      }
      identity = { principal: principalOf(session.role), sessionId: session.id, threadId: null };
    } else if (token !== null && grant === null) {
      if (token === core.token) {
        identity = { principal: 'owner', sessionId: null, threadId: null };
      } else {
        const found = token.length > 0 ? core.sessions.authenticate(token) : null;
        // A token that is neither the core's nor a pairing's may still be the
        // one a thread put in the environment of a process it launched.
        const threadId = found === null && token.length > 0 ? core.agents.authenticate(token) : null;
        if (found === null && threadId === null) {
          refuse('the token is wrong', 'bad token');
          return;
        }
        identity = found === null
          ? { principal: 'agent', sessionId: null, threadId }
          : { principal: principalOf(found.role), sessionId: found.id, threadId: null };
      }
    } else {
      refuse('hello takes a token or a grant, one of the two', 'bad hello');
      return;
    }
    if (params?.protocolVersion !== PROTOCOL_VERSION) {
      connection.sendResponse({ jsonrpc: '2.0', id, error: {
        code: RpcErrorCode.InvalidParams, message: `protocolVersion must be ${PROTOCOL_VERSION}`,
      } });
      connection.close(RpcCloseCode.ProtocolMismatch, 'protocol version mismatch');
      return;
    }
    connection.identity = identity;
    connection.authenticated = true;
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        core: core.info(),
        principal: identity.principal,
        ...(session === undefined ? {} : { session: { id: session.id, token: session.token } }),
        // The agent learns which thread it is in from its own hello, so the CLI
        // needs nothing but the token to name it.
        ...(identity.threadId === null ? {} : { threadId: identity.threadId }),
      },
    });
    return;
  }

  if (method === 'hello') {
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      result: {
        core: core.info(),
        principal: connection.identity.principal,
        ...(connection.identity.threadId === null ? {} : { threadId: connection.identity.threadId }),
      },
    });
    return;
  }

  try {
    const result = await core.router.dispatch(method, frame.params, { connection });
    connection.sendResponse({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (error instanceof RpcFailure) {
      connection.sendResponse({ jsonrpc: '2.0', id, error: error.toError() });
      return;
    }
    // An unexpected throw is a bug here, not something the user can act on.
    // SQLite sentences, absolute paths and stack fragments used to reach the
    // screen verbatim. The cause stays in the log, the client gets a sentence.
    core.log('error', `${method} failed: ${messageOf(error)}`);
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: RpcErrorCode.Internal, message: 'Something went wrong. Try again.' },
    });
  }
}
