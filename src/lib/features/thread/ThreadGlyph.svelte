<script lang="ts">
  import type { ThreadStatus } from "$lib/types";
  import type { IconKey } from "$lib/types";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";

  /**
   * One mark per thread, carrying what it is and how it is doing.
   *
   * The sidebar row used to wear two: a status dot on the left and the agent's
   * logo on the right, at opposite ends of the same short label. Two glyphs on a
   * 200px row read as two objects, and neither one is the row — so the ring is
   * the status and the logo inside it is the identity, and the pair is a single
   * thing the eye lands on once.
   *
   * It stays the keep-awake toggle, which is the one affordance the dot owned:
   * losing it would have moved a one-click setting into a context menu.
   */
  type Props = {
    status: ThreadStatus;
    iconKey?: IconKey;
    /** The model tint, when the thread came from fastpick. */
    color?: string | null;
    asleep?: boolean;
    keepAwake?: boolean;
    size?: number;
    /** Rendered as a span rather than a button. For drag ghosts and read-only
        lists, where a nested button would swallow the row's own click. */
    inert?: boolean;
    onToggleKeepAwake?: () => void;
    title?: string;
    label?: string;
  };
  let {
    status,
    iconKey = null,
    color = null,
    asleep = false,
    keepAwake = false,
    size = 20,
    inert = false,
    onToggleKeepAwake,
    title,
    label,
  }: Props = $props();

  // Keep-awake outranks the process state on purpose: it is the only one of the
  // two the user set by hand, and it is the one they are looking for when they
  // scan the list for what will still be alive later.
  const ringColor = $derived.by(() => {
    if (keepAwake) return "var(--color-awake)";
    switch (status) {
      case "running":
        return "var(--color-warning)";
      case "ready":
      case "done":
        return "var(--color-success)";
      case "exited":
      case "error":
        return "var(--color-danger)";
      default:
        return "var(--color-border-strong)";
    }
  });

  const spinning = $derived(status === "running");
  const glyphSize = $derived(Math.round(size * 0.62));
</script>

<!-- Two branches rather than one <svelte:element>: the interactive form has to
     be a real button to be reachable by keyboard, and the inert form has to not
     be one at all, because every place that renders it is already inside a
     button or an aria-hidden drag ghost. -->
{#if inert}
  <span
    class="glyph inert"
    class:spinning
    class:asleep
    style:--ring={ringColor}
    style:width="{size}px"
    style:height="{size}px"
    {title}
  >
    <ShortcutIcon {iconKey} size={glyphSize} {color} />
  </span>
{:else}
  <button
    type="button"
    class="glyph"
    class:spinning
    class:asleep
    style:--ring={ringColor}
    style:width="{size}px"
    style:height="{size}px"
    onclick={(e) => {
      e.stopPropagation();
      onToggleKeepAwake?.();
    }}
    {title}
    aria-label={label}
    data-no-drag
  >
    <ShortcutIcon {iconKey} size={glyphSize} {color} />
  </button>
{/if}

<style>
  .glyph {
    position: relative;
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 9999px;
    background: transparent;
    cursor: pointer;
    /* The ring itself, so ::after is free to be the moving part. */
    box-shadow: inset 0 0 0 1.5px var(--ring);
    transition: box-shadow var(--dur-2) var(--ease-out-quint);
  }
  .glyph.inert {
    cursor: default;
  }

  /* A thread nobody is keeping awake and nothing is running reads as furniture;
     the ring is there to be found, not to be seen. */
  .glyph.asleep {
    opacity: 0.55;
  }

  /* Running. The ring's own colour drops to a track and an arc of it sweeps
     round, which is the same information the braille spinner carried without
     spending a second glyph on it. */
  .glyph.spinning {
    box-shadow: inset 0 0 0 1.5px
      color-mix(in srgb, var(--ring) 22%, transparent);
  }
  .glyph.spinning::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: conic-gradient(
      from 0deg,
      transparent 0deg 200deg,
      var(--ring) 340deg,
      var(--ring) 360deg
    );
    /* Hollow the disc out into a ring of the same width as the track. */
    mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 1.5px),
      #000 calc(100% - 1.5px)
    );
    -webkit-mask: radial-gradient(
      farthest-side,
      transparent calc(100% - 1.5px),
      #000 calc(100% - 1.5px)
    );
    animation: glyph-spin 1.1s linear infinite;
  }
  @keyframes glyph-spin {
    to {
      transform: rotate(1turn);
    }
  }
  /* The global gate flattens animation-duration to near zero, which would park
     the arc at whatever angle it stopped on and read as a broken ring. A solid
     one still says "running" — it just says it without moving. */
  :global(html[data-motion="reduced"]) .glyph.spinning::after {
    display: none;
  }
  :global(html[data-motion="reduced"]) .glyph.spinning {
    box-shadow: inset 0 0 0 1.5px var(--ring);
  }
</style>
