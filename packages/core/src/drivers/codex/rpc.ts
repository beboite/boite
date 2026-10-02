import type { CoreLogContext } from '@boite/contracts';
/**
 * The client half of the Codex app-server protocol: `codex app-server` over the
 * agent's own stdio, JSON-RPC framed as ndjson. Shaped like `acp.ts`, but with
 * no SDK behind it: the app-server protocol ships as generated TypeScript, not
 * as a client library, so the peer below is the whole transport.
 *
 * The names used here are the ones `codex app-server generate-ts` writes:
 * `initialize` / `InitializeParams`, `thread/start` / `ThreadStartParams`,
 * `thread/resume` / `ThreadResumeParams`, `turn/start` / `TurnStartParams`,
 * `turn/interrupt`, the `item/*` notifications and the `item/*` server
 * requests. The wire has one surprise worth writing down: the server answers
 * without a `jsonrpc` member, so nothing here may require one.
 */
import { messageOf } from '../../errors.ts';
import type { SpawnedChild } from '../../procs.ts';
import { isRpcEnvelope, StdioTransport, type StdioRequestOptions } from '../stdio.ts';

// ---------------------------------------------------------------------------
// The transport: ndjson JSON-RPC over the child's stdio
// ---------------------------------------------------------------------------

interface RpcHandlers {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', message: string, context?: CoreLogContext): void;
  fault?(reason: string): void;
}

/**
 * One line of JSON per message, both ways. Requests carry an id and are
 * answered by it, notifications carry none, and a request the server sends is
 * answered by id too. Nothing here requires a `jsonrpc` member on the way in,
 * because the real app-server does not write one.
 */
export class CodexRpc {
  private nextId = 1;
  private readonly transport: StdioTransport<number>;

  constructor(
    child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    this.transport = new StdioTransport(child, 'codex agent', { message: message => this.dispatch(message), log: handlers.log, fault: handlers.fault });
  }

  request<T>(method: string, params: unknown, options?: StdioRequestOptions): Promise<T> {
    const id = this.nextId++;
    return this.transport.request(id, method, { jsonrpc: '2.0', id, method, params }, options);
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
      void this.answer(id as number | string, method, message['params']);
      return;
    }
    if (typeof method === 'string') {
      this.handlers.notification(method, message['params']);
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.transport.take(id);
    if (entry === undefined) return;
    const error = message['error'];
    if (error !== undefined && error !== null) {
      const text = (error as { message?: unknown }).message;
      entry.reject(new Error(typeof text === 'string' ? text : JSON.stringify(error)));
      return;
    }
    entry.resolve(message['result']);
  }

  private async answer(id: number | string, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.request(method, params);
      this.transport.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.transport.write({ jsonrpc: '2.0', id, error: { code: -32603, message: messageOf(error) } });
    }
  }
}
