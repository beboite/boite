import type { MessageKey } from "$lib/i18n/index.svelte";
import { fuzzyScore } from "./fuzzy";
import { SECTION_BIAS, SECTION_ORDER, SECTION_TITLE_KEYS } from "./sections";
import type { PaletteCommand } from "./registry";

/** A command with its text resolved: what the row shows and what search matches. */
export interface PaletteRow {
  c: PaletteCommand;
  label: string;
  hint: string | null;
  ranges?: [number, number][];
  matchedField?: "label" | "hint";
}

/**
 * What the list shows, in the order it shows it.
 *
 * Two halves, and they are ranked by two different things on purpose.
 *
 * Commands are scored against the query here, biased by their section, and that
 * is the whole ordering: they come out of the local registry and nothing else
 * has an opinion about them.
 *
 * Content hits are not scored at all. They arrive already ranked — FTS5 ordered
 * the rows, the transcript scan found the lines — and re-scoring an excerpt
 * against the same query would sort by how early the word happens to appear in
 * a sentence, which is not a relevance anybody asked for. So they follow every
 * command, in the order they were given, which is also what keeps them one
 * contiguous section under one header.
 */
export function rankRows(rows: PaletteRow[], query: string): PaletteRow[] {
  const q = query.trim();
  if (!q) return SECTION_ORDER.flatMap((s) => rows.filter((r) => r.c.section === s));

  const scored: { r: PaletteRow; score: number }[] = [];
  const content: PaletteRow[] = [];
  for (const r of rows) {
    const section = r.c.section;
    // `files` joins `content` here rather than being scored: file mode draws its
    // own list from the backend and never reaches this function, so a file row
    // arriving in a command-mode list is one that has no ranking to compute.
    if (section === "content" || section === "files") {
      content.push(r);
      continue;
    }
    const labelRes = fuzzyScore(q, r.label, { fuzzy: true });
    const hintRes = r.hint ? fuzzyScore(q, r.hint, { fuzzy: false }) : null;
    if (labelRes === null && hintRes === null) continue;

    let bestScore: number;
    let matchedField: "label" | "hint";
    let ranges: [number, number][];

    if (labelRes !== null && (hintRes === null || labelRes.score >= hintRes.score)) {
      bestScore = labelRes.score;
      matchedField = "label";
      ranges = labelRes.ranges;
    } else {
      bestScore = hintRes!.score;
      matchedField = "hint";
      ranges = hintRes!.ranges;
    }

    scored.push({
      r: { ...r, ranges, matchedField },
      score: bestScore + SECTION_BIAS[section],
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = scored.map((x) => x.r);
  for (const r of content) out.push(r);
  return out;
}

/**
 * The header this row opens, or null when the row above it is already in the
 * same section.
 */
export function sectionTitleKeyAt(
  rows: PaletteRow[],
  index: number,
): MessageKey | null {
  const item = rows[index];
  if (!item) return null;
  if (index === 0 || rows[index - 1].c.section !== item.c.section) {
    return SECTION_TITLE_KEYS[item.c.section];
  }
  return null;
}
