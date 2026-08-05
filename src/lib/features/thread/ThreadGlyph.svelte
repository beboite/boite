<script lang="ts" module>
  import type { ThreadToken as Token } from "./threadVisual";

  /**
   * One character per state, none of them a shape the eye has to resolve at
   * 12px. `zed` is lowercase because a capital Z beside a filename reads as the
   * first letter of the filename.
   */
  const TOKEN_CHAR: Record<Token, string> = {
    dot: "●",
    ask: "?",
    check: "✓",
    ring: "○",
    zed: "z",
    bang: "!",
  };
</script>

<script lang="ts">
  import type { SidebarDesign, ThreadStatus } from "$lib/types";
  import type { IconKey } from "$lib/types";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { stateTokenOf, threadVisual, TONE_COLOR } from "./threadVisual";

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
   *
   * Under the glow design the card itself carries the status, so the ring goes
   * away entirely rather than dimming to a hairline: a circle around a logo that
   * is already inside a lit card is a second frame drawn around one fact. What
   * is left is the logo on its own, or — when the logos are off — the state's
   * own mark, and keep-awake moves to a violet pip on the corner.
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
    /** Which sidebar design the row is drawn in. */
    design?: SidebarDesign;
    /** Whether the agent's logo is shown at all. Glow design only. */
    showLogo?: boolean;
    /** The row is hovered, which asks for the logo whatever the rest says. */
    revealLogo?: boolean;
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
    design = "classic",
    showLogo = true,
    revealLogo = false,
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
      // Amber like running, because both are the agent's turn still open. The
      // ring pulses instead of sweeping: nothing is progressing, and the only
      // thing that will move it is the user. Without this arm the one status
      // worth interrupting for wore the same ring as an idle thread.
      case "waiting":
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

  const glow = $derived(design === "glow");
  const spinning = $derived(!glow && status === "running");
  const waiting = $derived(!glow && status === "waiting" && !keepAwake);
  const glyphSize = $derived(Math.round(size * (glow ? 0.7 : 0.62)));

  const visual = $derived(threadVisual({ status, asleep, keepAwake }));
  // The logo wins while the row is hovered, whatever is in its place. Nothing
  // else is a way to ask "which agent is this one", and it is the question the
  // glyph exists to answer.
  const token = $derived(
    glow && !showLogo && !revealLogo ? stateTokenOf(visual.state) : null,
  );

  const toneColor = $derived(TONE_COLOR[visual.tone]);
</script>

{#snippet body()}
  {#if token}
    <span class="token" aria-hidden="true">{TOKEN_CHAR[token]}</span>
  {:else}
    <ShortcutIcon {iconKey} size={glyphSize} {color} />
  {/if}
  <!-- Keep-awake was the ring's one job, and the glow design has no ring. A
       pip on the corner rather than a tint on the mark itself, because the mark
       is already spending its colour on the state. -->
  {#if glow && keepAwake}
    <span class="pip" aria-hidden="true"></span>
  {/if}
{/snippet}

<!-- Two branches rather than one <svelte:element>: the interactive form has to
     be a real button to be reachable by keyboard, and the inert form has to not
     be one at all, because every place that renders it is already inside a
     button or an aria-hidden drag ghost. -->
{#if inert}
  <span
    class="glyph inert"
    class:spinning
    class:waiting
    class:asleep={asleep && !glow}
    class:bare={glow}
    style:--ring={ringColor}
    style:--tone={toneColor}
    style:--token-size="{Math.round(size * 0.58)}px"
    style:width="{size}px"
    style:height="{size}px"
    {title}
  >
    {@render body()}
  </span>
{:else}
  <button
    type="button"
    class="glyph"
    class:spinning
    class:waiting
    class:asleep={asleep && !glow}
    class:bare={glow}
    style:--ring={ringColor}
    style:--tone={toneColor}
    style:--token-size="{Math.round(size * 0.58)}px"
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
    {@render body()}
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

  /* The glow design's glyph is the logo and nothing else. No ring, no track, no
     second circle: the lit card is where the state lives, and a mark drawn
     around a mark is how a 200px row runs out of room. */
  .glyph.bare {
    box-shadow: none;
    border-radius: var(--radius-sm);
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

  /* Waiting on the user. The ring is whole and breathes, which reads as "stopped
     here" next to the sweep of a thread that is still working. */
  .glyph.waiting {
    animation: glyph-waiting 1.2s ease-in-out infinite;
  }
  @keyframes glyph-waiting {
    50% {
      box-shadow: inset 0 0 0 1.5px
        color-mix(in srgb, var(--ring) 30%, transparent);
    }
  }

  /* The state's own mark, standing where the logo stands. It is drawn in the
     state's colour and it never moves: the rail beside it is already the one
     moving thing on the row, and a second one turns a list into a fairground. */
  .token {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    /* Sized off the glyph's own box rather than off `em`: the card sets no
       font-size, so an em here would inherit whatever the sidebar happens to be
       and the mark would not keep step with the logo it replaced. */
    font-size: var(--token-size);
    font-weight: 700;
    line-height: 1;
    color: var(--tone);
    user-select: none;
  }

  /* Keep-awake, on the corner. Ringed in the surface colour so it stays a
     separate object over a logo of any shape. */
  .pip {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 5px;
    height: 5px;
    border-radius: 9999px;
    background: var(--color-awake);
    box-shadow: 0 0 0 1.5px var(--color-surface-2);
    pointer-events: none;
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
  /* Same bargain as the dot: a blinking mark is what a vestibular or
     photosensitivity setting asks to be spared, and the amber alone still
     separates waiting from idle. */
  :global(html[data-motion="reduced"]) .glyph.waiting {
    animation: none;
  }
</style>
