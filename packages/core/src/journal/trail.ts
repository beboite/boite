/**
 * Event types nothing reads back: the message row holds their content. Their
 * trail keeps the shape and the start of each long string, not a second copy
 * of every tool output, screenshot and published file.
 */
export const TRAIL_ONLY = new Set(['message.started', 'message.part', 'artifact.published']);
export const TRAIL_TEXT_CHARS = 1024;

export function trailOf(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length <= TRAIL_TEXT_CHARS ? value : `${value.slice(0, TRAIL_TEXT_CHARS)}[${value.length - TRAIL_TEXT_CHARS} more characters]`;
  }
  if (Array.isArray(value)) return value.map(trailOf);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, trailOf(entry)]));
  }
  return value;
}
