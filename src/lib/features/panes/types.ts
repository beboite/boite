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
  | { kind: "browser"; url: string };

export type PaneKind = PaneContent["kind"];

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

export const MAX_LEAVES = 4;
export const MIN_RATIO = 0.12;
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
