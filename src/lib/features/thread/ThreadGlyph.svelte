<script lang="ts">
  import type { ThreadStatus } from "$lib/types";
  import type { IconKey } from "$lib/types";
  import ShortcutIcon from "$lib/shared/icons/ShortcutIcon.svelte";
  import { stateGlyphOf, threadVisual } from "./threadVisual";

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
   * Under the glow design the card behind it says the status, so the ring drops
   * to a hairline and the middle is free to say something the colour cannot: the
   * Z's of a sleeping thread, the question mark of one that is blocked on an
   * answer. Those replace the logo rather than crowd it, and holding the card
   * brings the logo back.
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
    /** The card carries the status: draw the quiet variant of the glyph. */
    glow?: boolean;
    /** Whether the agent's logo is shown at all. Glow design only. */
    showLogo?: boolean;
    /** The card is being held, which asks for the logo whatever the rest says. */
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
    glow = false,
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

  const spinning = $derived(!glow && status === "running");
  const waiting = $derived(!glow && status === "waiting" && !keepAwake);
  const glyphSize = $derived(Math.round(size * 0.62));

  const visual = $derived(threadVisual({ status, asleep, keepAwake }));
  // The logo wins while the card is held, whatever is in its place. Nothing else
  // is a way to ask "which agent is this one", and it is the question the glyph
  // exists to answer.
  const stateGlyph = $derived(glow && !revealLogo ? stateGlyphOf(visual.state) : null);
  const logo = $derived(!glow || revealLogo || (showLogo && !stateGlyph));
</script>

{#snippet body()}
  {#if stateGlyph === "sleep"}
    <!-- ZZz, ZzZ, zZZ: one wave crossing three letters rather than four hand-
         written frames, so it never lands between two of them. Small and grey on
         purpose — a sleeping thread is the one the eye should skip. -->
    <span class="mark zzz" aria-hidden="true">
      <span style:--phase="0s">Z</span><span style:--phase="-0.53s">Z</span><span
        style:--phase="-1.06s">Z</span
      >
    </span>
  {:else if stateGlyph === "ask"}
    <span class="mark ask" aria-hidden="true">?</span>
  {:else if logo}
    <ShortcutIcon {iconKey} size={glyphSize} {color} />
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
    class:asleep
    class:quiet={glow}
    style:--ring={ringColor}
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
    class:asleep
    class:quiet={glow}
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

  /* Under the glow design the card is the status. A second full-strength ring
     around the logo is the same sentence twice, and the keep-awake violet is the
     one thing the card does not say, so the ring stays as a hairline for it. */
  .glyph.quiet {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ring) 45%, transparent);
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

  /* Both marks are deliberately under-lit. They stand where the agent's logo
     stands, and a Z that is louder than the logo it replaced turns a row that is
     doing nothing into the loudest thing in the sidebar. */
  .mark {
    display: inline-flex;
    align-items: baseline;
    font-size: 0.55em;
    font-weight: 700;
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--color-muted-foreground);
    user-select: none;
  }
  .zzz > span {
    animation: glyph-zzz 1.6s var(--ease-in-out-quad) infinite;
    animation-delay: var(--phase);
    opacity: 0.35;
  }
  @keyframes glyph-zzz {
    0%,
    100% {
      opacity: 0.28;
      transform: scale(0.72) translateY(0.5px);
    }
    25% {
      opacity: 0.8;
      transform: scale(1) translateY(-0.5px);
    }
    60% {
      opacity: 0.28;
      transform: scale(0.72) translateY(0.5px);
    }
  }
  .ask {
    font-size: 0.72em;
    animation: glyph-ask 1.5s var(--ease-in-out-quad) infinite;
  }
  @keyframes glyph-ask {
    0%,
    100% {
      opacity: 0.75;
    }
    50% {
      opacity: 0.25;
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
  /* Same bargain as the dot: a blinking mark is what a vestibular or
     photosensitivity setting asks to be spared, and the amber alone still
     separates waiting from idle. */
  :global(html[data-motion="reduced"]) .glyph.waiting {
    animation: none;
  }
  :global(html[data-motion="reduced"]) .zzz > span,
  :global(html[data-motion="reduced"]) .ask {
    animation: none;
    opacity: 0.6;
  }
</style>
