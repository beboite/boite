/**
 * A client that reports its conversation `attentive` (on a visible, focused
 * window used lately) repeats it every `ATTENTION_RENEW_MS`; the core believes
 * it for `ATTENTION_LEASE_MS` after the last report, so a phone suspended
 * before it could say otherwise stops silencing push within that time. After
 * the client looks away, the thread stays attended for `ATTENTION_GRACE_MS`.
 */
export const ATTENTION_RENEW_MS = 15_000;
export const ATTENTION_LEASE_MS = 40_000;
export const ATTENTION_GRACE_MS = 5_000;
/** A focused window nobody has touched for this long is not being watched. */
export const ATTENTION_IDLE_MS = 3 * 60_000;

/** A connection protects unsent input by identifier, without sending its content. */
export const PROTECTED_THREAD_LIMIT = 256;

export function protectedThreadIdsError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > PROTECTED_THREAD_LIMIT || value.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    return `protectedThreadIds must contain at most ${PROTECTED_THREAD_LIMIT} nonempty thread ids of at most 128 characters`;
  }
  return null;
}
