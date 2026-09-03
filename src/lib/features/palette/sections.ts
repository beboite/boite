import type { MessageKey } from "$lib/i18n/index.svelte";

export type PaletteSection =
  | "threads"
  | "actions"
  | "panes"
  | "projects"
  /** A settings catalogue entry. Only drawn once something is typed. */
  | "settings"
  /** Something the workspace wrote down, found by `search.query`. */
  | "content"
  /** A file under the thread's own root, found by the file mode. */
  | "files";

/** Every section whose rows are scored against the query. See `rank.ts`. */
export type ScoredSection = Exclude<PaletteSection, "content" | "files">;

// Ranking bias when a query is active: a thread you can jump to beats an
// action of the same textual score, which beats selecting a project.
//
// `content` and `files` are absent, and the type says so rather than a comment:
// neither is ever scored against the query — a hit is not, and file rows only
// exist in file mode, where they are the whole list and the backend has already
// ordered them — so a bias for either would be a number nothing reads.
// `rank.ts` holds why.
export const SECTION_BIAS: Record<ScoredSection, number> = {
  threads: 6,
  actions: 3,
  panes: 2,
  settings: 1,
  projects: 0,
};

// The empty-query list, in the order it is drawn. Anything missing from here
// exists only for a typed query. Threads already have Ctrl+digit and the
// sidebar, so they go last of the commands; settings stay off this list so a
// blank palette does not open on forty deep links.
export const SECTION_ORDER: PaletteSection[] = [
  "actions",
  "panes",
  "projects",
  "threads",
  "content",
];

// Keys rather than strings: the section headers are drawn by a component that
// only knows the section, so the literal has to live on the data.
export const SECTION_TITLE_KEYS: Record<PaletteSection, MessageKey> = {
  threads: "project.threads",
  actions: "palette.sectionActions",
  panes: "palette.panes",
  projects: "sidebar.projects",
  settings: "palette.sectionSettings",
  content: "palette.sectionContent",
  files: "palette.sectionFiles",
};
