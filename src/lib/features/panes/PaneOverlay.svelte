<script lang="ts">
  import { paneStore, countLeaves } from "./store.svelte";
  import type { PaneGroup } from "./types";
  import type { Thread } from "$lib/types";

  type Props = {
    thread: Thread;
    group: PaneGroup;
    focused: boolean;
  };
  let { thread, group, focused }: Props = $props();

  const isMultiPane = $derived(countLeaves(group.root) > 1);
  const hoveredFromSidebar = $derived(
    paneStore.hoveredThreadId === thread.id && isMultiPane,
  );
  const showFocusRing = $derived(focused && isMultiPane);
</script>

<div
  class="overlay"
  class:hovered-sidebar={hoveredFromSidebar}
  class:focused={showFocusRing}
  role="presentation"
></div>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 5;
  }
  .overlay.hovered-sidebar::after,
  .overlay.focused::after {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: 6px;
    pointer-events: none;
  }
  .overlay.focused::after {
    box-shadow: inset 0 0 0 1px var(--color-border, rgba(255, 255, 255, 0.18));
  }
  .overlay.hovered-sidebar::after {
    box-shadow: inset 0 0 0 2px var(--color-foreground, #fafafa);
    animation: pulse 1.2s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 0.4; }
  }
</style>
