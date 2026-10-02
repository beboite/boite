import type { CoreLogContext } from '@boite/contracts';
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
import { isRecord, isRpcEnvelope, StdioTransport, type StdioRequestOptions } from '../stdio.ts';
import type { InitializeResult } from './protocol.ts';
import { CLIENT_NAME, CLIENT_TITLE, SCHEMA_VERSION } from './protocol.ts';

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

interface RpcHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string, context?: CoreLogContext): void;
  fault?(reason: string): void;
}

export class MuseRpc {
  private nextId = 1;
  private readonly transport: StdioTransport<number>;

  constructor(
    child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    this.transport = new StdioTransport(child, 'muse host', { message: message => this.dispatch(message), log: handlers.log, fault: handlers.fault });
  }

  request<T>(method: string, params: unknown, options?: StdioRequestOptions): Promise<T> {
    const id = this.nextId++;
    return this.transport.request(id, method, { jsonrpc: '2.0', id, method, params }, options);
  }

  /** A command: a request whose params carry a fresh `commandId`. */
  command<T>(method: string, params: Record<string, unknown>, onAccepted?: () => void): Promise<T> {
    return this.request<T>(method, { commandId: mintUuidV7(), ...params }, { onAccepted });
  }

  notify(method: string, params: unknown): void {
    this.transport.write({ jsonrpc: '2.0', method, params });
  }

  /** The child is gone: every request still waiting is answered, loudly. */
  fail(reason: string, diagnostic?: string): void {
    this.transport.fail(reason, diagnostic);
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];
    if (!isRpcEnvelope(message)) return this.transport.invalid();
    if (typeof method === 'string' && id !== undefined && id !== null) {
      // `approval/request` and `userInput/request`: Boite decides both through
      // their notification and a command, so the request form is declined.
      this.transport.write({
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
        isRecord(params) ? params : {},
      );
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.transport.take(id);
    if (entry === undefined) return;
    const error = message['error'];
    if (error !== undefined && error !== null) {
      entry.reject(mspErrorOf(entry.method, error));
      return;
    }
    try {
      // Promise continuations run after every notification in this pipe chunk.
      entry.onAccepted?.();
      entry.resolve(message['result']);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    }
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
