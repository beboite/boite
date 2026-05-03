export type SplitDir = "row" | "column";

export type LayoutNode =
  | { kind: "leaf"; threadId: string }
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
  focusedThreadId: string;
}

export type DropSide = "top" | "bottom" | "left" | "right";

export const MAX_LEAVES = 4;
export const MIN_RATIO = 0.12;
