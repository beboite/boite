/** A connection protects unsent input by identifier, without sending its content. */
export const PROTECTED_THREAD_LIMIT = 256;

export function protectedThreadIdsError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > PROTECTED_THREAD_LIMIT || value.some(id => typeof id !== 'string' || id.length === 0 || id.length > 128)) {
    return `protectedThreadIds must contain at most ${PROTECTED_THREAD_LIMIT} nonempty thread ids of at most 128 characters`;
  }
  return null;
}
