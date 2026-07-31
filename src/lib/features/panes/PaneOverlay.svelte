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
    z-index: var(--z-pane-overlay);
  }
  .overlay.hovered-sidebar::after,
  .overlay.focused::after {
    content: "";
    position: absolute;
    inset: 2px;
    border-radius: 6px;
    pointer-events: none;
  }
  /* No fallbacks: both tokens are defined in app.css for every paint, and the
     ones that used to sit here were translucent white where --color-border is a
     solid dark grey, so the only thing a fallback could do was lie. */
  .overlay.focused::after {
    box-shadow: inset 0 0 0 1px var(--color-border);
  }
  .overlay.hovered-sidebar::after {
    box-shadow: inset 0 0 0 2px var(--color-foreground);
    animation: pulse var(--dur-pulse) ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 0.4; }
  }
</style>
