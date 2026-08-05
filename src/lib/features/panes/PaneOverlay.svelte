<script lang="ts">
  import { paneStore, countLeaves } from "./store.svelte";
  import type { PaneGroup } from "./types";
  import type { Thread } from "$lib/types";

  type Props = {
    thread: Thread;
    group: PaneGroup;
    focused: boolean;
    /**
     * This thread's workspace is unreachable, in dynamic mode where the rest of
     * the app is not. Drawn per pane and not per window, because the pane is the
     * scope of the problem: the local threads beside it are fine.
     */
    offline?: boolean;
  };
  let { thread, group, focused, offline = false }: Props = $props();

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
  class:offline
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
  .overlay.focused::after,
  .overlay.offline::after {
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
  /* Last of the three on purpose: same specificity, so it wins over both the
     focus ring and the sidebar hover. A pane whose boite is gone has a more
     urgent thing to say than which pane the keyboard is in, and unlike those
     two it is drawn in a single pane as well. */
  .overlay.offline::after {
    box-shadow: inset 0 0 0 2px var(--color-warning);
    animation: pulse var(--dur-pulse) ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 0.85; }
    50% { opacity: 0.4; }
  }
</style>
