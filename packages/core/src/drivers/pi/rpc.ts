/**
 * The client half of pi's RPC mode: `pi --mode rpc` over the agent's own stdio,
 * JSON objects one per line. Shaped like `codex.ts`, and like it with no SDK
 * behind it: pi ships `rpc-client.ts` inside its own package, not as a library,
 * so the peer below is the whole transport.
 *
 * The names used here are pi's own (`docs/rpc.md` of
 * `@earendil-works/pi-coding-agent`): the `prompt` and `abort` commands, the
 * `response` envelope that answers a command by its `id`, the `message_update`
 * deltas, the `tool_execution_*` events, `message_end` for the authoritative
 * assistant message and `agent_settled` for the end of a run.
 *
 * Two things about the wire are worth writing down. It is strict JSONL with LF
 * as the only delimiter, so nothing here may split on anything else. And pi has
 * no approval gate in RPC mode: the only request it sends back is an extension's
 * `extension_ui_request`, drawn as an inline question.
 */
import type { SpawnedChild } from '../../procs.ts';
import { LineSplitter } from '../lines.ts';
import { STDERR_MAX } from './protocol.ts';

interface PeerHandlers {
  event(message: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string): void;
}

/**
 * pi's RPC framing: commands out, responses and events in, one JSON object per
 * line. A command carries an `id` and its `response` carries the same one, so a
 * command that has to be waited on is a promise keyed by that id. Everything
 * else on the way in is an event.
 *
 * Records split on `\n` only, and a trailing `\r` is stripped: `U+2028` and
 * `U+2029` are valid inside a JSON string and pi says so in its own docs.
 */
export class PiPeer {
  private nextId = 1;
  private readonly pending = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  private readonly lines = new LineSplitter((line) => {
    this.onLine(line);
  });
  private closed = false;

  constructor(
    private readonly child: SpawnedChild,
    private readonly handlers: PeerHandlers,
  ) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.lines.feed(chunk);
    });
    child.stdin.on('error', () => undefined);
  }

  /** Sends a command and waits for the `response` that carries the same id. */
  command(type: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = `boite-${this.nextId}`;
    this.nextId += 1;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (this.closed) {
        reject(new Error(`the pi agent is gone, ${type} was not sent`));
        return;
      }
      this.pending.set(id, { resolve, reject });
      this.write({ id, type, ...params });
    });
  }

  /** An answer to something pi asked, which carries pi's own id and no response. */
  answer(payload: Record<string, unknown>): void {
    this.write(payload);
  }

  /** The child is gone: every command still waiting is answered, loudly. */
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

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.handlers.log('warn', `pi agent: a line that is not json: ${line.slice(0, STDERR_MAX)}`);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (message['type'] !== 'response') {
      this.handlers.event(message);
      return;
    }
    const id = message['id'];
    if (typeof id !== 'string') return;
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    this.pending.delete(id);
    if (message['success'] === false) {
      const error = message['error'];
      entry.reject(new Error(typeof error === 'string' ? error : `pi refused ${String(message['command'])}`));
      return;
    }
    entry.resolve(message);
  }
}

/** The `data` block of a `response`, or an empty record when there is none. */
export function dataOf(answer: Record<string, unknown>): Record<string, unknown> {
  const data = answer['data'];
  return data === null || typeof data !== 'object' ? {} : (data as Record<string, unknown>);
}
