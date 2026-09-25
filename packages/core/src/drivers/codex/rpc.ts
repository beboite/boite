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
import { LineSplitter } from '../lines.ts';
import { STDERR_MAX } from './protocol.ts';

// ---------------------------------------------------------------------------
// The transport: ndjson JSON-RPC over the child's stdio
// ---------------------------------------------------------------------------

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface RpcHandlers {
  notification(method: string, params: unknown): void;
  request(method: string, params: unknown): Promise<unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * One line of JSON per message, both ways. Requests carry an id and are
 * answered by it, notifications carry none, and a request the server sends is
 * answered by id too. Nothing here requires a `jsonrpc` member on the way in,
 * because the real app-server does not write one.
 */
export class CodexRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly lines = new LineSplitter((line) => {
    this.onLine(line);
  });
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: RpcHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.lines.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the codex agent is gone, ${method} was not sent`));
        return;
      }
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
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

  private onLine(raw: string): void {
    const line = raw.trim();
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.handlers.log('warn', `codex agent: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Record<string, unknown>): void {
    const method = message['method'];
    const id = message['id'];
    if (typeof method === 'string' && id !== undefined && id !== null) {
      void this.answer(id as number | string, method, message['params']);
      return;
    }
    if (typeof method === 'string') {
      this.handlers.notification(method, message['params']);
      return;
    }
    if (typeof id !== 'number') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
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
      this.write({ jsonrpc: '2.0', id, result });
    } catch (error) {
      this.write({ jsonrpc: '2.0', id, error: { code: -32603, message: messageOf(error) } });
    }
  }
}
