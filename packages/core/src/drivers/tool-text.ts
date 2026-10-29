/** A tool's result as the text a card shows: strings as they are, anything else as JSON, nothing as null. */
export function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return String(value);
  }
}
