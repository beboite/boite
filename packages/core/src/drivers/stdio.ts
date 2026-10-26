import type { CoreLogContext } from '@boite/contracts';
import type { SpawnedChild } from '../procs.ts';
import { withLogDiagnostic } from '../log-errors.ts';
import { LineSplitter, STDOUT_LINE_MAX } from './lines.ts';
import { EXIT_GRACE_MS } from './exit.ts';

export interface StdioRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onAccepted?(): void;
}

interface Pending {
  method: string;
  onAccepted?(): void;
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}

/** Framing and request lifetime only: the adapter owns its protocol envelopes. */
export class StdioTransport<Id extends string | number> {
  private readonly pending = new Map<Id, Pending>();
  private closed = false;
  private drainingStdout = false;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly child: SpawnedChild,
    private readonly label: string,
    private readonly handlers: {
      message(message: Record<string, unknown>): void;
      log(level: 'info' | 'warn' | 'error', message: string, context?: CoreLogContext): void;
      fault?(reason: string): void;
    },
  ) {
    const lines = new LineSplitter(line => this.onLine(line), {
      maxLine: STDOUT_LINE_MAX,
      onOverflow: () => this.break(`stdout line exceeded ${STDOUT_LINE_MAX} code units`),
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { if (!this.closed) lines.feed(chunk); });
    child.stdout.on('end', () => { lines.end(); this.break('stdout ended'); });
    child.stdout.on('error', () => this.break('stdout read failed'));
    child.stdout.on('close', () => this.break('stdout closed'));
    child.stdin.on('error', () => this.break('stdin write failed'));
    // Input can close before the accepted turn's last stdout records drain.
    child.stdin.on('close', () => this.drain());
  }

  request<T>(id: Id, method: string, payload: unknown, options: StdioRequestOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed || this.drainingStdout || options.signal?.aborted) {
        reject(new Error(`${this.label}: ${this.closed || this.drainingStdout ? 'transport closed' : 'request cancelled'}`));
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = () => this.take(id)?.reject(new Error(`${this.label}: request cancelled`));
      this.pending.set(id, {
        method, onAccepted: options.onAccepted, resolve: resolve as (value: unknown) => void, reject,
        cleanup: () => { clearTimeout(timer); options.signal?.removeEventListener('abort', cancel); },
      });
      options.signal?.addEventListener('abort', cancel, { once: true });
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => this.take(id)?.reject(new Error(`${this.label}: request timed out`)), options.timeoutMs);
        timer.unref?.();
      }
      this.write(payload);
    });
  }

  take(id: Id): Pending | undefined {
    const entry = this.pending.get(id);
    if (entry !== undefined) { this.pending.delete(id); entry.cleanup(); }
    return entry;
  }

  write(payload: unknown): void {
    if (this.closed || this.drainingStdout) return;
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
        if (error) this.break('stdin write failed');
      });
    } catch {
      this.break('stdin write failed');
    }
  }

  fail(reason: string, diagnostic?: string): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.drainTimer);
    this.drainTimer = undefined;
    this.drainingStdout = false;
    for (const id of this.pending.keys()) {
      const error = new Error(reason);
      this.take(id)?.reject(diagnostic === undefined ? error : withLogDiagnostic(error, diagnostic));
    }
  }

  invalid(reason = 'invalid message envelope'): void {
    this.handlers.log('warn', `${this.label}: ${reason}`, { event: 'provider.protocolError' });
  }

  private drain(): void {
    if (this.closed || this.drainingStdout) return;
    this.drainingStdout = true;
    // Prompt requests have no default deadline. A live child that keeps stdout
    // open must still reach the session's fault/exit handling within a bound.
    this.drainTimer = setTimeout(() => this.break('stdout drain timed out after stdin closed'), EXIT_GRACE_MS);
    this.drainTimer.unref?.();
  }

  private break(reason: string): void {
    if (this.closed) return;
    this.invalid(reason);
    this.fail(`${this.label}: ${reason}`);
    try { this.handlers.fault?.(`${this.label}: ${reason}`); }
    catch { this.invalid('transport fault handler failed'); }
  }

  private onLine(line: string): void {
    if (this.closed) return;
    let message: unknown;
    try { message = JSON.parse(line); }
    catch { this.invalid('stdout record is not JSON'); return; }
    if (!isRecord(message)) { this.invalid(); return; }
    try { this.handlers.message(message); }
    catch { this.break('message handler failed'); }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isRpcEnvelope(message: Record<string, unknown>): boolean {
  const method = message['method'], id = message['id'];
  return (method === undefined || typeof method === 'string') &&
    (id === undefined || id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)));
}
