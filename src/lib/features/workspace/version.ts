/**
 * Comparing two boite versions, for the one question the picker asks: is that
 * server behind the build looking at it?
 *
 * Not a semver library. What travels here is this repo's own version string,
 * the same one every crate and `package.json` carry, so the parts are numeric
 * and the only exotic shape is a pre-release suffix on a dev build. Anything
 * that does not parse answers "cannot tell" rather than a guess, because a
 * wrong "behind" badge on a boite that is fine is worse than no badge.
 */

interface Parsed {
  parts: number[];
  // A `-rc.1` on an otherwise equal version is older than the release.
  pre: boolean;
}

function parse(raw: string): Parsed | null {
  const trimmed = raw.trim().replace(/^v/i, "");
  if (!trimmed) return null;
  const [core] = trimmed.split("+");
  const [numbers, ...rest] = core.split("-");
  const parts = numbers.split(".").map((p) => Number(p));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
  return { parts, pre: rest.length > 0 };
}

/**
 * `-1` when `a` is older than `b`, `1` when it is newer, `0` when they are the
 * same version or when either one cannot be read.
 */
export function compareVersions(a: string, b: string): number {
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return 0;
  const len = Math.max(left.parts.length, right.parts.length);
  for (let i = 0; i < len; i++) {
    // A missing segment is a zero: 1.2 and 1.2.0 are the same release.
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  return left.pre ? -1 : 1;
}

/** Whether `remote` is an older release than `local`. Unknown reads as false. */
export function isBehind(remote: string | null, local: string): boolean {
  if (!remote) return false;
  return compareVersions(remote, local) < 0;
}
