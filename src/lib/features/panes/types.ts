export type SplitDir = "row" | "column";

/**
 * What is inside a pane.
 *
 * A leaf used to be `{ threadId }` and nothing else, which made the pane tree
 * structurally incapable of holding anything but a terminal — so the only thing
 * a split could ever give you was a second terminal, which `Ctrl+Tab` already
 * reached. The idea of splitting was never the problem; what could go in the
 * split was.
 *
 * `thread` keeps its identity: the pane id of a thread pane IS the thread id.
 * That is not a shortcut, it is the invariant — a thread lives in exactly one
 * pane, so the two identities were always the same one, and everything already
 * keyed on a thread id (the rects, the group index, the drop targets) keeps
 * working unchanged.
 */
export type PaneContent =
  | { kind: "thread"; threadId: string }
  /** The project's own page, so the dashboard can sit beside the agent. */
  | { kind: "dashboard" }
  | { kind: "git" }
  | { kind: "explorer" }
  | { kind: "todo" }
  /**
   * The editor, with its own tab strip.
   *
   * One per group rather than one pane per file, deliberately: buffers are a
   * single global set, so two file panes would be two views fighting over which
   * one owns the active tab. Opening a second file focuses this pane and
   * switches its tab, which is what an editor group does everywhere else.
   */
  | { kind: "editor" }
  /**
   * A page, and the agent pointing it.
   *
   * `drivenBy` rides on the pane rather than in a store beside it, and that is
   * what makes the hand-over hold: the mark is created, moved, saved and thrown
   * away with the pane it belongs to, so it survives a group switch and a
   * reload, and it cannot outlive a pane that has been closed. A map keyed by
   * pane id would have needed a sweep to stay true, and a sweep that is one
   * release late is an agent still steering something the user took back.
   *
   * `null` means the pane is the user's: one they opened, or one they took
   * back. Agent calls at it are refused, never queued.
   */
  | { kind: "browser"; url: string; drivenBy?: string | null };

export type PaneKind = PaneContent["kind"];

/**
 * The three the right rail held, and the three the titlebar toggles.
 *
 * Declared here rather than beside the toggle because the store remembers which
 * one is open, and it cannot import the module that opens them.
 */
export type PanelKind = "git" | "explorer" | "todo";

export type LayoutNode =
  | { kind: "leaf"; paneId: string; content: PaneContent }
  | {
      kind: "split";
      id: string;
      dir: SplitDir;
      ratios: number[];
      children: LayoutNode[];
    };

export interface PaneGroup {
  id: string;
  projectId: string;
  root: LayoutNode;
  focusedPaneId: string;
}

export type DropSide = "top" | "bottom" | "left" | "right";

/**
 * Panes in one group.
 *
 * Four was a stand-in for "a screen only holds so much", and it was the wrong
 * shape of answer: it refused a fifth pane on a 4K monitor and allowed a fourth
 * on a 1280px laptop where all four were unreadable. What a screen holds is a
 * width question, and MIN_COLUMN_PX is the one that answers it. This stays as
 * the ceiling on the tree itself, high enough not to be what the user meets
 * first.
 */
export const MAX_LEAVES = 8;
export const MIN_RATIO = 0.12;
/**
 * The narrowest a pane may be and still be given a column of its own.
 *
 * Below this a terminal wraps mid-word, the git panel's file rows are all
 * ellipsis and the explorer shows indentation instead of names, so a split that
 * would land there is turned on its side and the new pane goes under its
 * neighbour instead. 240px is where the file rows in `GitPanel` stop
 * truncating.
 */
export const MIN_COLUMN_PX = 240;
/**
 * Floor a pane in pixels, not only as a fraction of its parent.
 *
 * MIN_RATIO alone is 12% of whatever the parent happens to be. With both side
 * panels open on a 720px window the main area is around 160px, so four panes
 * clamped at roughly 19px each: a terminal too narrow to read a single word, and
 * only recoverable by dragging the splitter back.
 */
export const MIN_PANE_PX = 120;
/** Each splitter between two cells, in px. Must match `.splitter` flex-basis. */
export const SPLITTER_PX = 4;

/** A thread pane is named by its thread. See `PaneContent`. */
export function threadPane(threadId: string): LayoutNode {
  return {
    kind: "leaf",
    paneId: threadId,
    content: { kind: "thread", threadId },
  };
}

/** The thread in this pane, or null when the pane holds something else. */
export function threadIdOf(content: PaneContent): string | null {
  return content.kind === "thread" ? content.threadId : null;
}

/**
 * Whether two contents are the same view of the same thing.
 *
 * Used to refuse a duplicate: asking for the git pane twice should focus the one
 * that is open rather than split the group again, or four calls from an agent
 * would fill the group with four copies of the same panel.
 */
export function sameContent(a: PaneContent, b: PaneContent): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "thread":
      return a.threadId === (b as typeof a).threadId;
    case "browser":
      return a.url === (b as typeof a).url;
    default:
      // git, explorer, todo, dashboard and editor are singletons per group:
      // there is only one of each to open.
      return true;
  }
}
