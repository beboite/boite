/**
 * A WebSocket and a ticket endpoint the tests drive by hand.
 *
 * Only ever imported by `*.test.ts` — it lives beside them rather than in a
 * `__mocks__` folder because both socket-level and backend-level tests need the
 * same handshake, and a second copy of it would be the thing that drifts.
 */

export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  /** Every socket the code under test constructed, oldest first. */
  static made: FakeWebSocket[] = [];

  static reset(): void {
    FakeWebSocket.made = [];
  }

  static get last(): FakeWebSocket | undefined {
    return FakeWebSocket.made[FakeWebSocket.made.length - 1];
  }

  readonly url: string;
  binaryType = "";
  readyState: number = FakeWebSocket.CONNECTING;
  /** Frames handed to `send`, in order. */
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.made.push(this);
  }

  send(data: string | Uint8Array): void {
    // What a browser does: anything but OPEN either throws or bins the bytes,
    // and a socket that reports a send it never made is the bug under test.
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("InvalidStateError");
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }

  // --- test-side drivers, never called by the code under test ---

  /** The server accepting the connection. */
  accept(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  /** The ids of the RPCs sent so far, in order. */
  rpcs(): { id: number; method: string }[] {
    return this.sent.flatMap((f) =>
      typeof f === "string" ? [JSON.parse(f) as { id: number; method: string }] : [],
    );
  }

  idOf(method: string): number | undefined {
    return this.rpcs().find((r) => r.method === method)?.id;
  }

  answer(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id, ok: true, result }) });
  }
}

/** A ticket endpoint whose round trip the test decides when to finish. */
export function ticketDoor() {
  let release: ((ticket: string) => void) | null = null;
  const signals: AbortSignal[] = [];
  const fetch = (_url: string, init?: { signal?: AbortSignal }) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise((resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      release = (ticket: string) =>
        resolve({ status: 200, ok: true, json: async () => ({ ticket }) });
    });
  };
  return {
    fetch,
    signals,
    /** Answer the round trip that is in flight. */
    issue(ticket = "t-1") {
      release?.(ticket);
    },
  };
}

/**
 * Takes a fresh socket through auth and hello, so the test can act on a link
 * the code under test believes is up.
 */
export async function completeHandshake(ws: FakeWebSocket): Promise<void> {
  ws.accept();
  const auth = ws.idOf("auth");
  if (auth === undefined) throw new Error("no auth rpc was sent");
  ws.answer(auth, {});
  // The hello goes out from the auth continuation, so it exists a microtask later.
  await Promise.resolve();
  await Promise.resolve();
  const hello = ws.idOf("hello");
  if (hello !== undefined) ws.answer(hello, { protocol: 1, version: "1.0.0" });
}
