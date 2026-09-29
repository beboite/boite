/** What a refused `session/load` says about the thread's session. */
import { messageOf } from '../../errors.ts';
import { plainObject } from './models.ts';
import { STDERR_MAX } from './protocol.ts';

/**
 * `session/load` refused by a live agent. `lost` is a refusal that means the
 * conversation is gone on its side; otherwise the thread keeps its session and
 * the next turn tries the load again.
 */
export class LoadRefused extends Error {
  constructor(message: string, readonly lost: boolean) {
    super(message);
  }
}

/**
 * A JSON-RPC error the agent answered with, as opposed to the SDK's own "the
 * connection closed".
 */
export function rpcRefusal(error: unknown): boolean {
  return error instanceof Error && typeof (error as { code?: unknown }).code === 'number';
}

/** A reason that names a session or conversation the agent does not have. */
const MISSING_SESSION = /\b(session|conversation)\b.{0,80}?\b(not found|no such|unknown|does not exist|doesn't exist|missing|expired|deleted)\b|\b(no such|unknown|missing) (session|conversation)\b/i;

/**
 * What a `session/load` refusal says about the session. `gone`: the agent
 * does not have it (-32002 resource not found, no `session/load` method at all,
 * or a reason that names a missing session, which is how an agent that throws
 * a plain error answers). `kept`: the session is fine and something else is
 * not (-32000 authentication required, -32800 cancelled). `unsure`: any other
 * error, such as an internal one while the agent read its storage; OpenCode
 * answers a missing session that way too, so the same refusal twice in a row
 * counts as gone.
 */
export function loadRefusal(error: unknown, reason: string): 'gone' | 'kept' | 'unsure' {
  const code = (error as { code: number }).code;
  if (code === -32000 || code === -32800) return 'kept';
  if (code === -32002 || code === -32601) return 'gone';
  return MISSING_SESSION.test(reason) || MISSING_SESSION.test(messageOf(error)) ? 'gone' : 'unsure';
}

/** The refusal in words: an internal error carries the real reason in `data.details`. */
export function rpcReason(error: unknown): string {
  const data = (error as { data?: unknown }).data;
  const details = plainObject(data)?.['details'];
  const reason = typeof details === 'string' && details.length > 0 ? details : messageOf(error);
  return reason.slice(0, STDERR_MAX);
}
