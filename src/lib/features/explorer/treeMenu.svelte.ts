import type { ContextMenuItem } from "$lib/shared/components/ContextMenu.svelte";

// Single shared menu state: TreeNode is recursive, so per-instance state
// would render one ContextMenu per node.
class TreeMenuStore {
  menu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  open(x: number, y: number, items: ContextMenuItem[]) {
    this.menu = { x, y, items };
  }

  close() {
    this.menu = null;
  }
}

export const treeMenu = new TreeMenuStore();
