/**
 * A client that reports its conversation `attentive` (on a visible, focused
 * window used lately) repeats it every `ATTENTION_RENEW_MS`; the core believes
 * it for `ATTENTION_LEASE_MS` after the last report, so a phone suspended
 * before it could say otherwise stops holding push back within that time.
 */
export const ATTENTION_RENEW_MS = 10_000;
export const ATTENTION_LEASE_MS = 25_000;
/**
 * A window in front that nobody has used for this long is not being watched:
 * the user sent a message and walked away. The desktop shell measures it on
 * the whole system, a browser on the page.
 */
export const ATTENTION_IDLE_MS = 45_000;
/** An attentive client reports new use at most this often, besides its renewals. */
export const ATTENTION_ACTIVITY_MS = 5_000;

/** A connection protects unsent input by identifier, without sending its content. */
export const PROTECTED_THREAD_LIMIT = 256;

export function protectedThreadIdsError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > PROTECTED_THREAD_LIMIT || value.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    return `protectedThreadIds must contain at most ${PROTECTED_THREAD_LIMIT} nonempty thread ids of at most 128 characters`;
  }
  return null;
}
