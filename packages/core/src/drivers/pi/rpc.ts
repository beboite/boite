import type { CoreLogContext } from '@boite/contracts';
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
import { isRecord, StdioTransport, type StdioRequestOptions } from '../stdio.ts';

interface PeerHandlers {
  event(message: Record<string, unknown>): void;
  log(level: 'info' | 'warn' | 'error', message: string, context?: CoreLogContext): void;
  fault?(reason: string): void;
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
  private readonly transport: StdioTransport<string>;

  constructor(
    child: SpawnedChild,
    private readonly handlers: PeerHandlers,
  ) {
    this.transport = new StdioTransport(child, 'pi agent', { message: message => this.dispatch(message), log: handlers.log, fault: handlers.fault });
  }

  /** Sends a command and waits for the `response` that carries the same id. */
  command(type: string, params: Record<string, unknown> = {}, options?: StdioRequestOptions): Promise<Record<string, unknown>> {
    const id = `boite-${this.nextId++}`;
    return this.transport.request(id, type, { id, type, ...params }, options);
  }

  /** An answer to something pi asked, which carries pi's own id and no response. */
  answer(payload: Record<string, unknown>): void {
    this.transport.write(payload);
  }

  /** The child is gone: every command still waiting is answered, loudly. */
  fail(reason: string, diagnostic?: string): void {
    this.transport.fail(reason, diagnostic);
  }

  private dispatch(message: Record<string, unknown>): void {
    if (typeof message['type'] !== 'string' || (message['id'] !== undefined && typeof message['id'] !== 'string')) return this.transport.invalid();
    if (message['type'] !== 'response') {
      this.handlers.event(message);
      return;
    }
    const id = message['id'];
    if (typeof id !== 'string') return;
    const entry = this.transport.take(id);
    if (entry === undefined) return;
    if (typeof message['success'] !== 'boolean') {
      this.transport.invalid();
      entry.reject(new Error('pi agent: invalid response envelope'));
      return;
    }
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
  return isRecord(data) ? data : {};
}
