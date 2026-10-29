/*
 * A client carried to a member of its group by another member.
 *
 * A phone opens its page on one machine and reaches the others directly when
 * it can: over HTTPS from a secure page, or at an address written as numbers.
 * A member that gives neither, a desktop on the tailnet with no certificate
 * for instance, is out of a secure page's reach, and one that sleeps behind
 * another network is out of anybody's. The machine that served the page can
 * still reach it, so it carries the client there.
 *
 * `/group/relay/<core id>/rpc` is the other member's socket, piped: the
 * client's first frame is its `hello` for that member, with `relay` holding
 * its key for this one. This member checks that key, takes it out, opens a
 * socket on the other member and passes the rest on. From then on every frame
 * goes through unread. The member at the end authenticates the hello as it
 * would any other: a ticket, or the key a ticket became.
 *
 * `/group/relay/<core id>/file/<ticket>` and `/view/<ticket>` are fetched
 * from the other member and streamed back. Their tickets are what opens them,
 * as at the member's own address.
 *
 * What this machine sees: everything the client says to the other member and
 * hears back, its key for that member included. A member of a group already
 * has full control of every other (docs/groups.md), so this gives it nothing
 * it did not have. The hop between the two members carries client traffic,
 * so it is held to the client's rule: the other member's HTTPS address when
 * it has one, otherwise one written as numbers, never a name over plain HTTP.
 */

import type { ServerWebSocket } from 'bun';
import { FILE_ROUTE, GROUP_RELAY_ROUTE, PROTOCOL_VERSION, RPC_PATH, RpcErrorCode, VIEW_ROUTE } from '@boite/contracts';
import type { Core } from '../core.ts';
import { messageOf } from '../errors.ts';
import { TextSocket } from '../ws-client.ts';
import { OUTBOUND_CONGESTION_TIMEOUT_MS, OUTBOUND_MAX_BUFFERED_BYTES } from '../server/connection.ts';
import { RELAYED_LINK_HEADER } from '../server/peer.ts';
import { ticketAddresses } from './addresses.ts';

/** One address of the other member gets this long to open before the next is tried. */
const DIAL_MS = 4000;
/** What the client may have sent past its hello while the other member is being reached. */
const QUEUE_MAX_BYTES = 32 * 1024 * 1024;
/** How often pipes to a machine that left the group are closed. */
const SWEEP_MS = 15_000;
/** The response headers a file or a view keeps on its way back. Bun's fetch already undid any compression. */
const KEPT_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control',
  'content-security-policy', 'x-content-type-options', 'referrer-policy', 'last-modified', 'etag',
];
/** Close codes a socket may be closed with by an endpoint; anything else becomes 1011. */
const SENDABLE = (code: number): boolean => code === 1000 || (code >= 1001 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

export interface RelayPath {
  coreId: string;
  /** What follows the core id: `/rpc`, `/file/<ticket>` or `/view/<ticket>`. */
  rest: string;
}

/** The machine and the path a relay route names, or null when the path is not one. */
export function parseRelayPath(pathname: string): RelayPath | null {
  const prefix = `${GROUP_RELAY_ROUTE}/`;
  if (!pathname.startsWith(prefix)) return null;
  const match = /^([0-9a-f]{64})(\/.*)$/.exec(pathname.slice(prefix.length));
  if (match === null) return null;
  return { coreId: match[1]!, rest: match[2]! };
}

/** A path the relay carries: the socket, a file or a view, and nothing else of the other member. */
function carried(rest: string): 'socket' | 'http' | null {
  if (rest === RPC_PATH) return 'socket';
  for (const route of [FILE_ROUTE, VIEW_ROUTE]) if (rest.startsWith(`${route}/`) && /^[A-Za-z0-9_-]{1,256}$/.test(rest.slice(route.length + 1))) return 'http';
  return null;
}

/** What a relayed socket carries on this machine's server. */
export interface RelaySocketData {
  relay: RelayPipe;
}

/** Not Bun's own WebSocket, which closes sound streams from a core's server with 1002 or 1011 (`ws-client.ts`). */
type Upstream = TextSocket;

/**
 * Who may be carried: a key this machine issued, or its own owner's token,
 * never an agent's. The session the key belongs to, null for the owner's
 * token; null altogether for anything else.
 */
/** The client's credential for this machine: its key, or a device's signature for this machine. */
export type RelayAuthenticator = (credential: string | object) => { sessionId: string | null } | null;

/** What the core sees of the server's relay: how many sockets it carries, and a way to drop those to former members. */
export interface RelaySink {
  readonly size: number;
  sweep(): void;
}

/** The bounds a relayed socket shares with the server's own before its hello is checked. */
export interface RelayBounds {
  helloTimeoutMs: number;
  /** The largest first frame read from a socket nobody has authenticated. */
  helloMaxBytes: number;
  /** How long the client may leave the relay's buffer unread before it is told to reconnect. */
  congestionTimeoutMs?: number;
}

export class RelayHub implements RelaySink {
  readonly #pipes = new Set<RelayPipe>();
  #timer: ReturnType<typeof setInterval> | null = null;

  readonly #core: Core;
  readonly #authenticate: RelayAuthenticator;
  readonly #bounds: RelayBounds;

  constructor(core: Core, authenticate: RelayAuthenticator, bounds: RelayBounds) {
    this.#core = core;
    this.#authenticate = authenticate;
    this.#bounds = bounds;}

  /**
   * The addresses this machine reaches `coreId` at for a client, the one that
   * answered last first. Null when `coreId` is not another live member.
   */
  targets(coreId: string): string[] | null {
    if (coreId === this.#core.coordination.card().coreId) return null;
    if (!this.#core.group.peers().some((peer) => peer.coreId === coreId)) return null;
    return ticketAddresses(this.#core.group.routes(coreId) ?? []);
  }

  /**
   * The answer to a request on a relay route that is not a socket upgrade, or
   * null when it is one, for the server to upgrade. 404 for a machine that is
   * not another member, so the route tells a stranger nothing about who is.
   */
  async http(request: Request, path: RelayPath): Promise<Response | null> {
    const kind = carried(path.rest);
    const targets = this.targets(path.coreId);
    if (kind === null || targets === null) return new Response('not found', { status: 404 });
    if (kind === 'socket') return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', { status: 405 });
    if (targets.length === 0) return new Response('that machine gives no address this one may carry a client to', { status: 502 });
    const search = new URL(request.url).search;
    const range = request.headers.get('range');
    for (const target of targets) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DIAL_MS);
      try {
        const upstream = await fetch(`${target}${path.rest}${search}`, {
          method: request.method,
          headers: range === null ? {} : { range },
          redirect: 'manual',
          signal: controller.signal,
        });
        clearTimeout(timer);
        this.#core.group.reached(path.coreId, target);
        const headers = new Headers();
        for (const name of KEPT_HEADERS) {
          const value = upstream.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        // Bun hands the body back decompressed: the length the other member said no longer holds.
        if (upstream.headers.has('content-encoding')) headers.delete('content-length');
        return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
      } catch {
        clearTimeout(timer);
      }
    }
    return new Response('that machine does not answer', { status: 502 });
  }

  /**
   * A pipe for a socket the server is about to upgrade; `peer` is the address its hello wait counts under, as for the server's own.
   * `remote` when the client asked for a host that is not loopback: its frames are deflated, as a direct remote socket's are.
   * `encrypted` when nobody reads the client's hop to this machine (`encryptedLink`): the other member is told, and a secret is
   * answered there only over a link encrypted end to end.
   */
  pipe(coreId: string, peer: string | null, remote = false, encrypted = false): RelayPipe {
    this.#arm();
    const pipe = new RelayPipe(this.#core, this, coreId, peer, this.#authenticate, this.#bounds, remote, encrypted);
    this.#pipes.add(pipe);
    return pipe;
  }

  /** The counted peers of the relayed sockets whose key for this machine is not checked yet. */
  *waitingPeers(): Generator<string> {
    for (const pipe of this.#pipes) if (!pipe.authenticated && pipe.peer !== null) yield pipe.peer;
  }

  /** A session revoked here carries nobody any more: its relayed sockets close with it. */
  closeSession(sessionId: string): void {
    for (const pipe of [...this.#pipes]) if (pipe.sessionId === sessionId) pipe.close(1008, 'session revoked');
  }

  ended(pipe: RelayPipe): void {
    this.#pipes.delete(pipe);
    if (this.#pipes.size === 0) this.#disarm();
  }

  get size(): number {
    return this.#pipes.size;
  }

  /** A machine that left the group, or that this one left, is carried to no more. */
  sweep(): void {
    for (const pipe of [...this.#pipes]) if (this.targets(pipe.coreId) === null) pipe.close(1001, 'no longer a machine of this group');
  }

  closeAll(): void {
    for (const pipe of [...this.#pipes]) pipe.close(1001, 'core stopping');
    this.#disarm();
  }

  #arm(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => this.sweep(), SWEEP_MS);
    this.#timer.unref?.();
  }

  #disarm(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/**
 * One client socket and the socket it opened on the other member. Until the
 * other member has answered, what the client sends waits here; after that,
 * each frame goes straight through in both directions.
 */
export class RelayPipe {
  #socket: ServerWebSocket<RelaySocketData> | null = null;
  #upstream: Upstream | null = null;
  #queue: string[] = [];
  #queued = 0;
  #helloSeen = false;
  #closed = false;
  #helloTimer: ReturnType<typeof setTimeout> | null = null;
  #congestionTimer: ReturnType<typeof setTimeout> | null = null;
  /** The client's key for this machine was checked: from then on it no longer counts as waiting for its hello. */
  authenticated = false;
  /** The session that key belongs to, null for the owner's token: revoking it closes this pipe. */
  sessionId: string | null = null;

  readonly #core: Core;
  readonly #hub: RelayHub;
  readonly #authenticate: RelayAuthenticator;
  readonly #bounds: RelayBounds;

  constructor(
    core: Core,
    hub: RelayHub,
    readonly coreId: string,
    readonly peer: string | null,
    authenticate: RelayAuthenticator,
    bounds: RelayBounds,
    readonly remote = false,
    readonly encrypted = false,
  ) {
    this.#core = core;
    this.#hub = hub;
    this.#authenticate = authenticate;
    this.#bounds = bounds;}

  attach(socket: ServerWebSocket<RelaySocketData>): void {
    this.#socket = socket;
    this.#helloTimer = setTimeout(() => {
      if (!this.authenticated) this.close(4001, 'hello timed out');
    }, this.#bounds.helloTimeoutMs);
  }

  receive(raw: string | Buffer): void {
    if (this.#closed) return;
    // Nothing larger than a hello is read from a socket nobody has authenticated, as on the server's own.
    if (!this.#helloSeen && (typeof raw === 'string' ? Buffer.byteLength(raw) : raw.length) > this.#bounds.helloMaxBytes) {
      this.close(4001, 'hello frame too large');
      return;
    }
    const text = typeof raw === 'string' ? raw : raw.toString();
    if (!this.#helloSeen) {
      this.#helloSeen = true;
      void this.open(text);
      return;
    }
    if (this.#upstream !== null && this.#upstream.open) {
      this.#upstream.send(text);
      return;
    }
    this.#queued += Buffer.byteLength(text);
    if (this.#queued > QUEUE_MAX_BYTES) {
      this.close(1009, 'too much sent before the other machine answered');
      return;
    }
    this.#queue.push(text);
  }

  /** The client's hello: its key for this machine is checked and taken out, the rest goes to the other member. */
  private async open(text: string): Promise<void> {
    let frame: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      this.close(4001, 'hello expected');
      return;
    }
    const id = typeof frame?.id === 'number' || typeof frame?.id === 'string' ? frame.id : null;
    if (frame?.method !== 'hello' || id === null || typeof frame.params !== 'object' || frame.params === null) {
      this.#refuse(id ?? 0, RpcErrorCode.Unauthorized, 'the first frame must be hello', 4001);
      return;
    }
    const { relay, ...rest } = frame.params;
    // A failure here is this machine's, not the other member's: never Unauthorized, which the client would take for its key there being revoked.
    const holder = (typeof relay === 'string' && relay.length > 0 && relay.length <= 512) || (typeof relay === 'object' && relay !== null) ? this.#authenticate(relay) : null;
    if (holder === null) {
      this.#refuse(id, RpcErrorCode.Refused, `${this.#name()} carries to the other machines of its group only a client paired with it: hello relay must be this client's key for ${this.#name()}, or its device signature for it`, 1008);
      return;
    }
    this.authenticated = true;
    this.sessionId = holder.sessionId;
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
    if (rest['protocolVersion'] !== PROTOCOL_VERSION) {
      // Said by the machine the client is talking to, so the client stops as it would there.
      this.#refuse(id, RpcErrorCode.InvalidParams, `protocolVersion must be ${PROTOCOL_VERSION}`, 4010);
      return;
    }
    const targets = this.#hub.targets(this.coreId);
    if (targets === null) {
      this.#refuse(id, RpcErrorCode.Unavailable, `that machine is no longer in the group of ${this.#name()}`, 1013);
      return;
    }
    const upstream = await this.#dial(targets);
    if (this.#closed) {
      upstream?.close();
      return;
    }
    if (upstream === null) {
      this.#refuse(id, RpcErrorCode.Unavailable, `${this.#name()} could not reach that machine at any address it may carry a client to`, 1013);
      return;
    }
    this.#upstream = upstream;
    // What came before these were in place waits for them, a close included.
    upstream.onMessage((text) => this.#forward(text));
    upstream.onClose((event) => this.close(SENDABLE(event.code) ? event.code : 1011, event.reason || 'the other machine closed the connection'));
    if (this.#closed) return;
    upstream.send(JSON.stringify({ ...frame, params: rest }));
    for (const queued of this.#queue) upstream.send(queued);
    this.#queue = [];
    this.#queued = 0;
  }

  /**
   * One frame of the other member's to the client, under the budget a direct
   * socket keeps. The other member sees this machine read at tailnet speed,
   * so its own limits never fire for a slow client: here, a client that falls
   * 32 MiB behind, stays congested for 10 s or has a frame dropped is told to
   * reconnect, and loads a fresh snapshot, rather than missing frames on a
   * socket that stays open.
   */
  #forward(data: string): void {
    const socket = this.#socket;
    if (this.#closed || socket === null) return;
    const bytes = Buffer.byteLength(data);
    try {
      if (socket.getBufferedAmount() + bytes > OUTBOUND_MAX_BUFFERED_BYTES) {
        this.close(1013, 'connection exceeded outgoing buffer limit; reconnect');
        return;
      }
      const sent = socket.send(data, this.remote);
      if (sent === 0) {
        this.close(1013, 'connection dropped a frame; reconnect');
        return;
      }
      if (sent < 0 || socket.getBufferedAmount() > 0) this.#congested();
    } catch {
      this.close(1011, 'the connection dropped');
    }
  }

  #congested(): void {
    this.#congestionTimer ??= setTimeout(() => this.close(1013, 'connection remained congested; reconnect'), this.#bounds.congestionTimeoutMs ?? OUTBOUND_CONGESTION_TIMEOUT_MS);
  }

  /** The client read some of what waited: the congestion clock starts again, or stops once nothing waits. */
  drained(): void {
    if (this.#closed) return;
    if (this.#congestionTimer !== null) clearTimeout(this.#congestionTimer);
    this.#congestionTimer = null;
    if ((this.#socket?.getBufferedAmount() ?? 0) > 0) this.#congested();
  }

  /** The first address of the other member that opens a socket, or null. */
  async #dial(targets: string[]): Promise<Upstream | null> {
    for (const target of targets) {
      if (this.#closed) return null;
      // The other core deflates what it sends a client that is not on its loopback: offered, as Bun's client did.
      const headers = { [RELAYED_LINK_HEADER]: this.encrypted ? 'encrypted' : 'plain' };
      const opened = await TextSocket.connect(`${target.replace(/^http/, 'ws')}${RPC_PATH}`, DIAL_MS, { deflate: true, headers }).catch(() => null);
      if (opened !== null) {
        this.#core.group.reached(this.coreId, target);
        return opened;
      }
    }
    return null;
  }

  #name(): string {
    return this.#core.info().hostname ?? 'this machine';
  }

  #refuse(id: number | string, code: number, message: string, closeCode: number): void {
    try {
      this.#socket?.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
    } catch (error) {
      this.#core.log('warn', `relay: ${messageOf(error)}`);
    }
    this.close(closeCode, message.slice(0, 120));
  }

  /** Both sockets go, once, and the hub forgets the pipe. */
  close(code = 1000, reason = ''): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#helloTimer !== null) clearTimeout(this.#helloTimer);
    if (this.#congestionTimer !== null) clearTimeout(this.#congestionTimer);
    this.#congestionTimer = null;
    this.#queue = [];
    const upstream = this.#upstream;
    this.#upstream = null;
    if (upstream !== null) {
      // Its close comes back to `close`, which has already run.
      upstream.close(SENDABLE(code) ? code : 1000, reason.slice(0, 120));
    }
    try { this.#socket?.close(SENDABLE(code) ? code : 1011, reason.slice(0, 120)); } catch { /* already gone */ }
    this.#hub.ended(this);
  }
}
