/**
 * Two versions of a file, the places they differ, and what the user chose to do
 * about each one.
 *
 * The whole semantic core of the merge tool lives here, in plain functions with
 * no DOM and no runes, because `Chunk.build` runs in bare node. That is not a
 * detail: the vitest setup in this repo is `environment: "node"` and cannot
 * mount a component, so anything worth asserting has to live in a module like
 * this one. What is left in the `.svelte` files is layout, `t()` calls and event
 * wiring.
 *
 * The thing this file exists for is `"both"`. `@codemirror/merge` ships
 * `revertControls` and `acceptChunk`, and both are two-way pick-a-side: there is
 * no union anywhere in the package, and no ordering. Keeping two edits that
 * landed in the same place, one after the other, is the whole reason the merge
 * tool is being built, so it is written here.
 */

import { Chunk } from "@codemirror/merge";
import { Text } from "@codemirror/state";

/**
 * What happens to one difference.
 *
 * `null` is undecided, which is a real state rather than a default: for a file
 * where stacking cannot be right, applying stays disabled until every one is
 * answered.
 */
export type Choice = "mine" | "theirs" | "both" | "bothReversed" | null;

export interface Hunk {
  /** Its index, which is stable for one pair of documents. */
  id: number;
  /** Character offsets into `mine`, clamped to the document. */
  fromA: number;
  toA: number;
  /** And into `theirs`. */
  fromB: number;
  toB: number;
  mineText: string;
  theirsText: string;
  /** Read from this machine's point of view: `added` is theirs and not ours. */
  kind: "added" | "removed" | "changed";
}

/**
 * Every place the two documents differ.
 *
 * `Chunk` documents that `toA` and `toB` may point one past the end of their
 * document — a file with no trailing newline does exactly that, measured — so
 * every offset is clamped before it reaches a slice.
 */
export function buildHunks(mine: string, theirs: string): Hunk[] {
  const a = Text.of(mine.split("\n"));
  const b = Text.of(theirs.split("\n"));
  return Chunk.build(a, b).map((chunk, id) => {
    const fromA = clamp(chunk.fromA, mine.length);
    const toA = clamp(chunk.toA, mine.length);
    const fromB = clamp(chunk.fromB, theirs.length);
    const toB = clamp(chunk.toB, theirs.length);
    const mineText = mine.slice(fromA, toA);
    const theirsText = theirs.slice(fromB, toB);
    return {
      id,
      fromA,
      toA,
      fromB,
      toB,
      mineText,
      theirsText,
      kind: mineText === "" ? "added" : theirsText === "" ? "removed" : "changed",
    };
  });
}

/**
 * The merged file.
 *
 * The runs *between* the differences are taken from `mine`, and that is safe
 * rather than a preference: a diff partitions both documents into alternating
 * common and changed runs, and the common runs are identical on both sides by
 * construction. Either document could supply them.
 *
 * An undecided difference is left as this machine has it. Nothing calls compose
 * on an undecided file to apply it — the footer will not let that happen — but a
 * preview has to draw something, and drawing this machine's own text is the only
 * answer that is never a surprise.
 */
export function compose(
  mine: string,
  theirs: string,
  hunks: Hunk[],
  choices: Choice[],
): string {
  let out = "";
  let cursor = 0;
  for (const hunk of hunks) {
    out += mine.slice(cursor, hunk.fromA);
    out += chosen(hunk, choices[hunk.id] ?? null);
    cursor = hunk.toA;
  }
  return out + mine.slice(cursor);
}

function chosen(hunk: Hunk, choice: Choice): string {
  switch (choice) {
    case "theirs":
      return hunk.theirsText;
    case "both":
      return join(hunk.mineText, hunk.theirsText);
    case "bothReversed":
      return join(hunk.theirsText, hunk.mineText);
    default:
      return hunk.mineText;
  }
}

/**
 * Two sides, one after the other, with exactly one newline between them.
 *
 * Without this, two markdown paragraphs stacked become one paragraph — which
 * reads as a bug in the merge tool rather than as what the user asked for.
 */
function join(first: string, second: string): string {
  if (first === "") return second;
  if (second === "") return first;
  return first.endsWith("\n") ? first + second : `${first}\n${second}`;
}

/**
 * What each difference starts on.
 *
 * `both` everywhere for a file where stacking can produce something valid —
 * markdown and plain text — because that is what the user asked the tool for,
 * and making them click through twenty differences in `AGENTS.md` would kill it.
 * Undecided everywhere else: two JSON objects stacked are a syntax error, so the
 * tool refuses to guess and applying stays disabled until every one is answered.
 */
export function defaultChoices(hunks: Hunk[], unionSafe: boolean): Choice[] {
  return hunks.map(() => (unionSafe ? "both" : null));
}

/** How many differences are still waiting on a person. */
export function undecided(choices: Choice[]): number {
  return choices.filter((choice) => choice === null).length;
}

/** One difference decided, without touching the rest. */
export function applyChoice(choices: Choice[], id: number, choice: Choice): Choice[] {
  if (id < 0 || id >= choices.length) return choices;
  const next = choices.slice();
  next[id] = choice;
  return next;
}

/** Everything still undecided decided the same way, and nothing else touched. */
export function fillUndecided(choices: Choice[], choice: Choice): Choice[] {
  return choices.map((existing) => (existing === null ? choice : existing));
}

/**
 * Whether stacking both sides of this file could produce something it can still
 * be read as.
 *
 * A property of the format rather than of the content, and the backend says
 * which format a file is — so this is a lookup, not a guess made in the webview.
 */
export function unionSafeSyntax(syntax: string): boolean {
  return syntax === "markdown" || syntax === "text";
}

function clamp(offset: number, length: number): number {
  return Math.max(0, Math.min(offset, length));
}
