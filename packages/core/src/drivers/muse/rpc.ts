/**
 * The client half of Muse Code's session protocol (MSP): `muse serve` over the
 * agent's own stdio, JSON-RPC 2.0 framed as ndjson. Shaped like `codex.ts`,
 * with its own transport rather than `@muse-code/sdk`: the SDK spawns its own
 * child through `node:child_process`, and every agent process here has to go
 * through `procs.spawnChild` to land in the trace and the Job Object.
 *
 * The names are the ones `muse schema generate-ts` writes: `initialize`,
 * `session/start`, `session/resume`, `turn/start`, `turn/interrupt`,
 * `session/compact`, `approval/decide`, `userInput/answer`, and the `item/*`,
 * `turn/*`, `approval/*`, `userInput/*` and `session/*` notifications. Three
 * rules of the wire shape everything below:
 *
 * - Every command carries a client-minted UUIDv7 `commandId`, and a fresh
 *   turn's id is the `commandId` of the `turn/start` that opened it.
 * - Approvals and questions arrive as notifications (`approval/requested`,
 *   `userInput/requested`) and are answered with commands. The server-request
 *   forms of both are refused, which is what the host expects of a client that
 *   decides through `approval/decide`.
 * - An item notification carries the whole item so far. Text already written
 *   from `item/delta` is skipped, only the unseen suffix is drawn.
 */
import pkg from '../../../package.json';
import type { SpawnedChild } from '../../procs.ts';
import type { InitializeResult } from './protocol.ts';
import { CLIENT_NAME, CLIENT_TITLE, SCHEMA_VERSION, STDERR_MAX } from './protocol.ts';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

let lastMintMs = 0;

let lastMintSeq = 0;

/**
 * A UUIDv7, which is what MSP wants for every `commandId` and a new session
 * id. Ids minted within one millisecond carry an increasing counter in the
 * random bits, so two commands sent back to back still sort in order.
 */
export function mintUuidV7(now: number = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  if (now <= lastMintMs) {
    lastMintSeq = (lastMintSeq + 1) & 0x0fff;
    now = lastMintMs;
  } else {
    lastMintMs = now;
    lastMintSeq = 0;
  }
  let ms = now;
  for (let at = 5; at >= 0; at -= 1) {
    bytes[at] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((lastMintSeq >> 8) & 0x0f);
  bytes[7] = lastMintSeq & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// The transport: ndjson JSON-RPC 2.0 over the child's stdio
// ---------------------------------------------------------------------------

/** An MSP error answer: its code, and the `data.kind` and `data.reason` the host sends with it. */
export class MspError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly kind: string | null,
    readonly reason: string | null,
  ) {
    super(message);
    this.name = 'MspError';
  }
}

interface Pending {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

export class MuseRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the muse host is gone, ${method} was not sent`));
        return;
      }
      this.pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** A command: a request whose params carry a fresh `commandId`. */
  command<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, { commandId: mintUuidV7(), ...params });
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  /** The child is gone: every request still waiting is answered, loudly. */
  fail(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) entry.reject(new Error(reason));
  }

  private write(payload: unknown): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // the pipe is already gone; the exit path says what happened
    }
  }

  private feed(chunk: string): void {
    this.buffer += chunk;
    for (; ;) {
      const at = this.buffer.indexOf('\n');
      if (at < 0) break;
      const line = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at + 1);
      if (line.length === 0) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.handlers.log('warn', `muse host: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      // `approval/request` and `userInput/request`: Boite decides both through
      // their notification and a command, so the request form is declined.
      this.write({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `boite answers ${method} through its notification, not as a request` },
      });
      return;
    }
    if (typeof method === 'string') {
      const params = message['params'];
      this.handlers.notification(
        method,
        params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {},
      );
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    const error = message['error'];
    if (error !== undefined && error !== null) {
      entry.reject(mspErrorOf(entry.method, error));
      return;
    }
    entry.resolve(message['result']);
  }
}

function mspErrorOf(method: string, raw: unknown): MspError {
  const error = (raw ?? {}) as { code?: unknown; message?: unknown; data?: unknown };
  const data = (error.data ?? {}) as { kind?: unknown; reason?: unknown };
  const kind = typeof data.kind === 'string' ? data.kind : null;
  const reason = typeof data.reason === 'string' ? data.reason : null;
  const text = typeof error.message === 'string' ? error.message : JSON.stringify(raw);
  return new MspError(method, typeof error.code === 'number' ? error.code : 0, text, kind, reason);
}

/** `initialize` then `initialized`, refusing an envelope this driver does not speak. */
export async function handshake(rpc: MuseRpc): Promise<InitializeResult> {
  const result = await rpc.request<InitializeResult>('initialize', {
    clientInfo: { name: CLIENT_NAME, title: CLIENT_TITLE, version: pkg.version },
    capabilities: { userInputDialogs: true },
  });
  const version = result.schema?.version;
  if (version !== SCHEMA_VERSION) {
    throw new Error(
      `the muse host speaks MSP envelope version ${version ?? 'unknown'}, Boite speaks ${SCHEMA_VERSION}: update Muse Code or Boite`,
    );
  }
  rpc.notify('initialized', {});
  return result;
}
