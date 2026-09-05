import { existsSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { RPC_PATH, RpcCloseCode, RpcErrorCode } from '@boite/contracts';
import type { RpcError, RpcEventName, RpcEvents, ThreadId } from '@boite/contracts';
import { eventThreadId } from './bus.ts';
import type { Core } from './core.ts';
import { RpcFailure, messageOf } from './errors.ts';
import { newId } from './ids.ts';
import type { Connection } from './router.ts';

const DEFAULT_HELLO_TIMEOUT_MS = 5000;
/**
 * The UI build. `packages/core/src` and `packages/core/dist` are the same depth,
 * so `../../ui/dist` is `packages/ui/dist` from either; a compiled core has no
 * repository above it and carries the build in a `ui` directory next to itself.
 */
function resolveUiDist(): string {
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

class ServerConnection implements Connection {
  readonly id = newId('con_');
  readonly subscriptions = new Set<ThreadId>();
  authenticated = false;

  private socket: ServerWebSocket<SocketData> | null = null;
  private congested = false;
  private readonly catchUp = new Set<string>();
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly core: Core) {}

  attach(socket: ServerWebSocket<SocketData>): void {
    this.socket = socket;
  }

  sendEvent<E extends RpcEventName>(name: E, payload: RpcEvents[E]): void {
    if (name === 'message.delta' && this.congested) {
      this.queueCatchUp(payload);
      return;
    }
    const sent = this.write({ jsonrpc: '2.0', method: name, params: payload });
    if (sent >= 0) return;
    this.congested = true;
    if (name === 'message.delta') this.queueCatchUp(payload);
  }

  sendResponse(response: OutgoingResponse): void {
    this.write(response);
  }

  close(code: number, reason?: string): void {
    this.socket?.close(code, reason);
  }

  bufferedAmount(): number {
    return this.socket?.getBufferedAmount() ?? 0;
  }

  private write(frame: unknown): number {
    if (this.socket === null) return 0;
    return this.socket.send(JSON.stringify(frame));
  }

  /** Backpressure: deltas are dropped, then the whole part is resent once the socket drains. */
  private queueCatchUp(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) return;
    const messageId = (payload as { messageId?: unknown }).messageId;
    if (typeof messageId !== 'string') return;
    this.catchUp.add(messageId);
    if (this.catchUpTimer !== null) return;
    this.catchUpTimer = setTimeout(() => {
      this.catchUpTimer = null;
      this.flushCatchUp();
    }, 0);
  }

  private flushCatchUp(): void {
    const ids = [...this.catchUp];
    this.catchUp.clear();
    for (const messageId of ids) {
      const message = this.core.journal.getMessage(messageId);
      if (message === null) continue;
      message.parts.forEach((part, partIndex) => {
        this.write({
          jsonrpc: '2.0',
          method: 'message.part',
          params: { threadId: message.threadId, messageId, partIndex, part },
        });
      });
    }
    this.congested = this.bufferedAmount() > 0;
    if (this.congested && this.catchUp.size > 0) this.queueCatchUp({ messageId: [...this.catchUp][0] });
  }
}

function envTimeout(): number | null {
  const raw = process.env.BOITE_HELLO_TIMEOUT_MS;
  if (raw === undefined || raw === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isAllowedOrigin(origin: string | null, port: number, host: string): boolean {
  if (origin === null || origin === '' || origin === 'null') return true;
  if (SHELL_ORIGINS.includes(origin)) return true;
  if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
  if (host === '127.0.0.1' || host === 'localhost') return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.port === String(port);
  } catch {
    return false;
  }
}

function staticFile(pathname: string): string | null {
  if (!existsSync(UI_DIST)) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(UI_DIST, relative));
  const root = resolve(UI_DIST);
  if (!resolve(full).startsWith(root + sep) && resolve(full) !== root) return null;
  return existsSync(full) ? full : null;
}

export function startServer(options: ServerOptions): RunningServer {
  const core = options.core;
  const host = options.host ?? '127.0.0.1';
  const helloTimeoutMs = options.helloTimeoutMs ?? envTimeout() ?? DEFAULT_HELLO_TIMEOUT_MS;
  const connections = new Set<ServerConnection>();

  const server = Bun.serve<SocketData>({
    hostname: host,
    port: options.port ?? 0,
    idleTimeout: 0,

    fetch(request, self) {
      const url = new URL(request.url);

      if (url.pathname === '/health') {
        return Response.json({ ok: true, version: core.version, pid: process.pid });
      }

      if (url.pathname === RPC_PATH) {
        const origin = request.headers.get('origin');
        if (!isAllowedOrigin(origin, self.port ?? 0, host)) {
          core.log('warn', `refused a websocket from origin ${origin ?? '(none)'}`);
          return new Response('forbidden origin', { status: 403 });
        }
        const connection = new ServerConnection(core);
        if (self.upgrade(request, { data: { connection } })) return undefined;
        return new Response('expected a websocket upgrade', { status: 400 });
      }

      const file = staticFile(url.pathname);
      if (file !== null) return new Response(Bun.file(file));
      if (url.pathname === '/') {
        return new Response(PLACEHOLDER_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      return new Response('not found', { status: 404 });
    },

    websocket: {
      open(socket) {
        const connection = socket.data.connection;
        connection.attach(socket);
        connections.add(connection);
        setTimeout(() => {
          if (connection.authenticated) return;
          connection.close(RpcCloseCode.Unauthorized, 'hello timed out');
        }, helloTimeoutMs);
      },

      message(socket, raw) {
        void handleFrame(core, socket.data.connection, typeof raw === 'string' ? raw : raw.toString());
      },

      close(socket) {
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
  };

  const off = core.bus.onAny((name, payload) => {
    const scoped = name.startsWith('message.') || name.startsWith('permission.');
    const threadId = eventThreadId(payload);
    for (const connection of connections) {
      if (!connection.authenticated) continue;
      if (scoped && (threadId === null || !connection.subscriptions.has(threadId))) continue;
      connection.sendEvent(name, payload);
    }
  });

  return {
    host,
    port,
    url: core.baseUrl(),
    async stop(): Promise<void> {
      off();
      for (const connection of connections) connection.close(1001, 'core stopping');
      connections.clear();
      // Bun 1.3.11 never resolves server.stop() once a socket has been upgraded,
      // so the listener is closed without waiting on that promise.
      void server.stop(true);
      await Promise.resolve();
    },
  };
}

async function handleFrame(core: Core, connection: ServerConnection, raw: string): Promise<void> {
  let frame: { id?: unknown; method?: unknown; params?: unknown };
  try {
    frame = JSON.parse(raw) as { id?: unknown; method?: unknown; params?: unknown };
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
    const params = frame.params as { token?: unknown } | undefined;
    if (typeof params?.token !== 'string' || params.token !== core.token) {
      connection.sendResponse({
        jsonrpc: '2.0',
        id,
        error: { code: RpcErrorCode.Unauthorized, message: 'the token is wrong' },
      });
      connection.close(RpcCloseCode.Unauthorized, 'bad token');
      return;
    }
    connection.authenticated = true;
    connection.sendResponse({ jsonrpc: '2.0', id, result: { core: core.info() } });
    return;
  }

  if (method === 'hello') {
    connection.sendResponse({ jsonrpc: '2.0', id, result: { core: core.info() } });
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
    connection.sendResponse({
      jsonrpc: '2.0',
      id,
      error: { code: RpcErrorCode.Internal, message: messageOf(error) },
    });
  }
}
