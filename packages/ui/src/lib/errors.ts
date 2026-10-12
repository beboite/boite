/** What a thrown value says: an `Error`'s message, anything else as text. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
