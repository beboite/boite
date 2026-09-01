/**
 * The reads that turn one stored settings key into a value the app can use.
 *
 * A settings blob comes back from a database an older build wrote, from a
 * remote workspace, or from a hand edit, so every field is read defensively.
 * Spelled inline that was fifty copies of
 * `typeof stored.x === "boolean" ? stored.x : DEFAULTS.x` inside `init()`, one
 * method carrying 82 branches, where a `>` typed instead of `>=` on any line
 * looks exactly like the line above it. Each rule is named here once instead,
 * and the store becomes a list of fields against the shape each one accepts.
 *
 * Out of the store module and free of runes for the same reason as
 * right-panel.ts: importing the store reaches the backend, the database and the
 * notification host, so nothing living in it can be tested on its own.
 *
 * Every helper takes the stored value first and the fallback last, and none of
 * them ever throws: the worst a corrupt row can do is hand back the default.
 */

/** A boolean, or the fallback. A stored `"true"` is a string and loses. */
export function keepBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Any string, `""` included, for a field where empty is a real answer. */
export function keepString<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" ? value : fallback;
}

/** A string with something in it. `""` is a row nobody filled in. */
export function keepNonEmpty<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" && value ? value : fallback;
}

/**
 * A string that is not blank, returned exactly as stored.
 *
 * The trim decides, it does not rewrite: a prompt template whose author put a
 * blank line at the top keeps it.
 */
export function keepNonBlank<T>(value: unknown, fallback: T): string | T {
  return typeof value === "string" && value.trim() ? value : fallback;
}

/** A number above zero: a width, a scale, anything a `0` would collapse. */
export function keepPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

/** A number that may be zero, which for a cap or a delay spells "none". */
export function keepAtLeastZero(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 ? value : fallback;
}

/** A split fraction strictly inside its edges: 0 or 1 is a pane nobody can see. */
export function keepFraction(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 && value < 1 ? value : fallback;
}

/**
 * A number inside a range, where the two edges answer differently.
 *
 * Under the floor is not a slow poll, it is a value written by something that
 * did not know about the floor, so it takes the default. Over the ceiling is a
 * choice the user made and can be honoured as far as the ceiling allows.
 */
export function keepBounded(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return typeof value === "number" && value >= min ? Math.min(value, max) : fallback;
}

/** A number the caller clamps itself, for a range that lives with its own feature. */
export function keepClamped(
  value: unknown,
  clamp: (n: number) => number,
  fallback: number,
): number {
  return typeof value === "number" ? clamp(value) : fallback;
}

/** Whatever the type guard accepts, and the fallback for everything else. */
export function keepIf<T, F>(
  value: unknown,
  accepts: (v: unknown) => v is T,
  fallback: F,
): T | F {
  return accepts(value) ? value : fallback;
}

/** An array, taken as it was stored. The fallback is copied, never shared. */
export function keepArray<T>(value: unknown, fallback: T[]): T[] {
  return Array.isArray(value) ? (value as T[]) : structuredClone(fallback);
}

/** Any object, taken as it was stored, for a map whose keys are the user's own. */
export function keepRecord<T extends object>(value: unknown, fallback: T): T {
  return typeof value === "object" && value !== null
    ? (value as T)
    : structuredClone(fallback);
}

/**
 * A stored map laid over the default one.
 *
 * For a map whose keys ship with the build: a key the stored blob predates
 * keeps its shipped answer instead of arriving undefined.
 */
export function keepMerged<T extends object>(value: unknown, fallback: T): T {
  return typeof value === "object" && value !== null
    ? { ...structuredClone(fallback), ...(value as Partial<T>) }
    : structuredClone(fallback);
}
