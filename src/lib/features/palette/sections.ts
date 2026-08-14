import type { MessageKey } from "$lib/i18n/index.svelte";

export type PaletteSection =
  | "threads"
  | "actions"
  | "panes"
  | "projects"
  /** Something the workspace wrote down, found by `search.query`. */
  | "content";

/** Every section whose rows are scored against the query. See `rank.ts`. */
export type ScoredSection = Exclude<PaletteSection, "content">;

// Ranking bias when a query is active: a thread you can jump to beats an
// action of the same textual score, which beats selecting a project.
//
// `content` is absent, and the type says so rather than a comment: a hit is
// never scored against the query, so a bias for it would be a number nothing
// reads. `rank.ts` holds why.
export const SECTION_BIAS: Record<ScoredSection, number> = {
  threads: 6,
  actions: 3,
  panes: 2,
  projects: 0,
};

// The empty-query list, in the order it is drawn. Anything missing from here
// exists only for a typed query.
export const SECTION_ORDER: PaletteSection[] = [
  "threads",
  "actions",
  "panes",
  "projects",
  "content",
];

// Keys rather than strings: the section headers are drawn by a component that
// only knows the section, so the literal has to live on the data.
export const SECTION_TITLE_KEYS: Record<PaletteSection, MessageKey> = {
  threads: "project.threads",
  actions: "palette.sectionActions",
  panes: "palette.panes",
  projects: "sidebar.projects",
  content: "palette.sectionContent",
};
