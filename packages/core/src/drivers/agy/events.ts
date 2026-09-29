/** Reading agy's stream-json events: loose rows, and the fields a turn takes out of them. */

/** What a log line or an error sentence keeps of one line agy wrote. */
export const STDERR_MAX = 400;

export type Row = Record<string, unknown>;

export function rowOf(value: unknown): Row {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
}

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** `result.error`, which is a sentence or an object carrying one. */
export function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const row = rowOf(value);
  const message = textOf(row['message']);
  if (message.length > 0) return message;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** One `agent_response` step's `usage`. `input_tokens` leaves the cache reads out. */
export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
}

/** Wherever the event carries it: `init`, a step or a `result`. */
export function conversationOf(event: Row): string | null {
  for (const holder of [event, rowOf(event['init']), rowOf(event['step_update']), rowOf(event['result'])]) {
    const id = textOf(holder['conversation_id']);
    if (id.length > 0) return id;
  }
  return null;
}
