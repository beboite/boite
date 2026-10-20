import { spyOn } from 'bun:test';
import { FrameQueue } from '../../src/server/frame-queue.ts';
import { ServerConnection } from '../../src/server/connection.ts';
import { Router } from '../../src/router.ts';
import { TextSocket } from '../../src/ws-client.ts';

/** Test-only bounded metadata: never retain a request, response body or credential. */
export function rpcTrace({ label = 'journal.inspect', methods = ['hello', 'pairing.grant', 'journal.inspect'] }: { label?: string; methods?: readonly string[] } = {}) {
  const events: Record<string, unknown>[] = [];
  const identities = new WeakMap<object, number>();
  const roles = new WeakMap<object, string>();
  const serverConnections = new Map<string, object>();
  let nextIdentity = 1;
  const started = performance.now(), wallStarted = Date.now();
  const identity = (object: object): number => {
    const known = identities.get(object);
    if (known !== undefined) return known;
    const id = nextIdentity++; identities.set(object, id); return id;
  };
  const record = (hop: string, object: object, metadata: Record<string, unknown> = {}): void => {
    if (events.length === 64) events.shift();
    events.push({ hop, connection: identity(object), role: roles.get(object), timing: Math.round(performance.now() - started), wallTiming: Date.now() - wallStarted, ...metadata });
  };
  const frame = (raw: unknown): Record<string, unknown> => {
    const type = typeof raw;
    const length = typeof raw === 'string' ? raw.length : raw instanceof ArrayBuffer ? raw.byteLength : ArrayBuffer.isView(raw) ? raw.byteLength : raw instanceof Blob ? raw.size : undefined;
    try {
      const value: unknown = JSON.parse(typeof raw === 'string' ? raw : '');
      if (!value || typeof value !== 'object') return { type, length };
      const parsed = value as { id?: unknown; method?: unknown; error?: { code?: unknown } };
      // The test uses numeric IDs and a fixed method whitelist. Arbitrary fields never enter the trace.
      return { ...(typeof parsed.id === 'number' ? { id: parsed.id } : {}),
        ...(methods.includes(String(parsed.method)) ? { method: parsed.method } : {}),
        ...(typeof parsed.error?.code === 'number' ? { code: parsed.error.code } : {}) };
    } catch { return { type, length }; }
  };
  const enqueue = FrameQueue.prototype.enqueue;
  const dispatch = Router.prototype.dispatch;
  const response = ServerConnection.prototype.sendResponse;
  const close = ServerConnection.prototype.close;
  const send = WebSocket.prototype.send;
  const addListener = WebSocket.prototype.addEventListener;
  const textSend = TextSocket.prototype.send;
  const onMessage = TextSocket.prototype.onMessage;
  const onClose = TextSocket.prototype.onClose;
  /** A message a client read: its frame, and the role a hello answer gives the connection. */
  const received = (socket: object, raw: unknown): void => {
    try {
      const principal = JSON.parse(String(raw)).result?.principal;
      if (['owner', 'session', 'agent'].includes(principal)) roles.set(socket, principal === 'session' ? 'phone' : principal);
    } catch { /* Metadata only; invalid frames remain classified by frame(). */ }
    record('client.receive', socket, frame(raw));
  };
  const closed = (socket: object, code: number, reason: string): void => {
    record('client.close', socket, { code, classification: reason === 'Protocol error - unexpected opcode' ? 'unexpected-opcode' : undefined });
  };
  const spies: { mockRestore(): void }[] = [
    spyOn(FrameQueue.prototype, 'enqueue').mockImplementation(function (this: FrameQueue, connection, raw) {
      serverConnections.set(connection.id, connection);
      record('server.enqueue', connection, { ...frame(raw), principal: connection.identity.principal });
      return enqueue.call(this, connection, raw);
    }),
    spyOn(Router.prototype, 'dispatch').mockImplementation(function (this: Router, method, params, ctx) {
      record('router.dispatch', ctx.connection, { ...(methods.includes(method) ? { method } : {}), principal: ctx.connection.identity.principal });
      return dispatch.call(this, method, params, ctx);
    }),
    spyOn(ServerConnection.prototype, 'sendResponse').mockImplementation(function (this: ServerConnection, value) {
      record('server.response', this, { id: typeof value.id === 'number' ? value.id : undefined, principal: this.identity.principal, code: value.error?.code });
      response.call(this, value);
      record('server.response.sent', this, { principal: this.identity.principal, bufferedAmount: this.bufferedAmount() });
    }),
    spyOn(ServerConnection.prototype, 'close').mockImplementation(function (this: ServerConnection, code, reason) {
      record('server.close', this, { principal: this.identity.principal, code, classification: reason === 'Protocol error - unexpected opcode' ? 'unexpected-opcode' : undefined });
      close.call(this, code, reason);
    }),
    spyOn(WebSocket.prototype, 'send').mockImplementation(function (this: WebSocket, raw) {
      record('client.send', this, { ...frame(raw), bufferedAmount: this.bufferedAmount });
      const result = send.call(this, raw);
      record('client.send.returned', this, { bufferedAmount: this.bufferedAmount });
      return result;
    }),
    spyOn(WebSocket.prototype, 'addEventListener').mockImplementation(function (this: WebSocket, type: string, listener: EventListener | { handleEvent(event: Event): void }, options?: boolean | AddEventListenerOptions) {
      if (type !== 'message' && type !== 'close') return addListener.call(this, type, listener, options);
      const observed: EventListener = event => {
        if (type === 'message') received(this, (event as MessageEvent).data);
        else closed(this, (event as CloseEvent).code, (event as CloseEvent).reason);
        if (typeof listener === 'function') listener.call(this, event);
        else listener?.handleEvent(event);
      };
      return addListener.call(this, type, observed, options);
    }),
    // The core client reads its socket through `ws-client.ts`.
    spyOn(TextSocket.prototype, 'send').mockImplementation(function (this: TextSocket, text) {
      record('client.send', this, frame(text));
      textSend.call(this, text);
      record('client.send.returned', this);
    }),
    spyOn(TextSocket.prototype, 'onMessage').mockImplementation(function (this: TextSocket, listener) {
      onMessage.call(this, text => { received(this, text); listener(text); });
    }),
    spyOn(TextSocket.prototype, 'onClose').mockImplementation(function (this: TextSocket, listener) {
      onClose.call(this, event => { closed(this, event.code, event.reason); listener(event); });
    }),
  ];
  let restored = false;
  return {
    restore() { if (restored) return; restored = true; for (const spy of spies.reverse()) spy.mockRestore(); },
    printFailure() { console.error(label + ' RPC trace ' + JSON.stringify(events)); },
    snapshot() { return events.map(event => ({ ...event })); },
  };
}

export function journalRpcTrace() { return rpcTrace(); }
