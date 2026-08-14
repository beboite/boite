import type { WorkspaceHit } from "$lib/backend/types";

/**
 * How short a query may be before the workspace is asked about it.
 *
 * One character matches most of what a workspace has ever written down, so the
 * answer is useless and the query is the most expensive one anybody can send:
 * the transcript half reads the tail of every terminal in the boite.
 */
export const MIN_SEARCH_LENGTH = 2;

/** How long the typing has to stop before the query goes out. */
export const SEARCH_DEBOUNCE_MS = 180;

/** What the backend is asked for. Its own cap is 100. */
export const SEARCH_LIMIT = 24;

/**
 * How many hits reach the list.
 *
 * Lower than what is asked for, because the answer is deduplicated on the way
 * in: one terminal printing the same line forty times is one row, and asking
 * for the cap exactly would leave the list short every time that happens.
 */
export const MAX_CONTENT_ROWS = 10;

/** Longest excerpt drawn on a row, past which nothing more is readable anyway. */
const MAX_EXCERPT_CHARS = 160;

/**
 * A transcript line as something to put on a row.
 *
 * Terminal output reaches this side with its escape sequences already stripped,
 * but not with its tabs, its carriage returns or the bell a build rang when it
 * failed: a row that keeps those is a row whose height changes per hit.
 */
export function tidyExcerpt(raw: string): string {
  // Compared rather than matched: a character class over the control range is
  // exactly what `no-control-regex` exists to refuse, and walking a line the
  // backend already capped at 240 characters costs nothing.
  let flat = "";
  for (const ch of raw.replace(/\s+/g, " ")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    flat += ch;
  }
  flat = flat.trim();
  if (flat.length <= MAX_EXCERPT_CHARS) return flat;
  return flat.slice(0, MAX_EXCERPT_CHARS).trimEnd() + "…";
}

/**
 * A stable id for a hit's row.
 *
 * The reference is not enough on its own: a transcript hit names its thread, so
 * a terminal that printed the same word on twenty lines answers with twenty
 * hits carrying one id between them, and the keyed `{#each}` would draw one row.
 */
export function contentRowId(hit: WorkspaceHit, index: number): string {
  return `content:${hit.kind}:${hit.refId}:${index}`;
}

/**
 * What is worth drawing, in the order the backend ranked it.
 *
 * Deduplicated on the kind, the reference and the text together: a progress bar
 * that redrew itself is on disk as two hundred identical lines, and the
 * transcript scan has no reason to know that one of them is enough.
 */
export function usableHits(hits: WorkspaceHit[]): WorkspaceHit[] {
  const seen = new Set<string>();
  const out: WorkspaceHit[] = [];
  for (const hit of hits) {
    if (out.length >= MAX_CONTENT_ROWS) break;
    const excerpt = tidyExcerpt(hit.excerpt);
    if (!excerpt) continue;
    const key = `${hit.kind}:${hit.refId}:${excerpt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...hit, excerpt });
  }
  return out;
}
