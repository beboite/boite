/**
 * The slash command hint, decided without a DOM.
 *
 * `session.started` carries the commands the driver declared, and typing `/`
 * is the only place they are worth showing. The hint is a filter and nothing
 * else: the text still goes to the driver untouched, which is what "slash
 * commands declared at init pass through" means in `docs/pilot.md`. Boite never
 * runs one itself, so this file has no idea what any of them do.
 *
 * The rule the shape enforces: **the hint is up only while the whole box is one
 * unfinished command.** A `/review` followed by a space is a command with an
 * argument being typed and the list has nothing left to add; a `/` on the
 * second line of a paragraph is a slash in a sentence. Both used to open a
 * menu over the composer while somebody was writing.
 */

/** How many commands the hint row offers before it stops. */
export const HINT_LIMIT = 6;

/**
 * The prefix being typed, or null when nothing is.
 *
 * Empty string is a real answer and means the box holds a bare `/`, which is
 * the case that should list everything.
 */
export function slashQuery(text: string): string | null {
  if (!text.startsWith("/")) return null;
  const body = text.slice(1);
  if (/[\s]/.test(body)) return null;
  return body;
}

/**
 * The commands matching what is typed, best first.
 *
 * A prefix match ranks above a match in the middle, so typing `re` offers
 * `review` before `compress-report`. Case-insensitive, because a command is
 * lowercase by convention and nobody types it that way twice.
 */
export function slashHints(
  text: string,
  commands: readonly string[],
  limit = HINT_LIMIT,
): string[] {
  const query = slashQuery(text);
  if (query === null) return [];
  const needle = query.toLowerCase();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const raw of commands) {
    const name = raw.trim();
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower === needle) continue;
    if (lower.startsWith(needle)) starts.push(name);
    else if (needle && lower.includes(needle)) contains.push(name);
  }
  return [...starts, ...contains].slice(0, Math.max(0, limit));
}

/**
 * The box after a hint has been chosen.
 *
 * A trailing space rather than a bare name: every one of these takes an
 * argument or takes nothing, and the space is free in the second case.
 */
export function applyHint(name: string): string {
  return `/${name.trim()} `;
}

/**
 * Where the selection lands after an arrow key, wrapping at both ends.
 *
 * Wrapping because the list is short and the alternative is a key that stops
 * answering at the bottom of six rows.
 */
export function moveHint(index: number, delta: number, count: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}
