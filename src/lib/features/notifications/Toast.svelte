<script lang="ts">
  import { onMount } from "svelte";
  import { tip } from "$lib/shared/actions/tooltip";
  import { t } from "$lib/i18n/index.svelte";
  import X from "@lucide/svelte/icons/x";
  import type { ToastKind } from "./store.svelte";

  type Props = {
    message: string;
    detail?: string;
    durationMs?: number | null;
    kind?: ToastKind;
    onDone: () => void;
  };
  let {
    message,
    detail = undefined,
    durationMs = 3000,
    kind = "info",
    onDone,
  }: Props = $props();

  // A card that never expires on its own has to be closable by hand, and a card
  // that does expire is still worth getting rid of early.
  const sticky = $derived(
    durationMs == null || !Number.isFinite(durationMs) || (durationMs ?? 0) <= 0,
  );

  // onMount, deliberately not $effect: an effect re-runs whenever the store
  // touches the toast list, so one card expiring re-armed the countdown of
  // every other card. Restarting on a repeat message is handled by Toaster
  // remounting this component on the resetKey instead.
  onMount(() => {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
      return;
    }
    const timer = setTimeout(() => onDone(), durationMs);
    return () => clearTimeout(timer);
  });
</script>

<!-- The role lives on the card, not on the stack. As one polite atomic region
     the container re-announced every card each time a new one arrived, and an
     error waited its turn behind whatever was already queued. -->
<div
  class="toast"
  class:success={kind === "success"}
  class:warning={kind === "warning"}
  class:error={kind === "error"}
  class:sticky
  role={kind === "error" ? "alert" : "status"}
>
  <!-- A dot rather than a glyph per kind. Three hand-drawn SVG icons said the
       same thing the colour already says, cost a different silhouette each and
       made the card read like every other framework's toast. Kind is not
       carried by colour alone: the role above is what a screen reader gets. -->
  <span class="dot" aria-hidden="true"></span>
  <div class="lines">
    <span class="message">{message}</span>
    <!-- Secondary detail: smaller and muted to keep from competing with the main message. -->
    {#if detail}
      <span class="detail">{detail}</span>
    {/if}
  </div>
  <button
    type="button"
    class="dismiss"
    onclick={onDone}
    aria-label={t("common.dismiss")}
    use:tip={t("common.dismiss")}
  >
    <X class="size-3" />
  </button>
</div>

<style>
  /* pointer-events only on the button. The whole card used to take them with no
     handler behind it, which on a phone parked a dead 320px target on top of the
     keyboard FAB for as long as the toast lasted. */
  .toast {
    pointer-events: none;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 8px;
    padding: 9px 10px 10px 11px;
    border-radius: var(--radius-md);
    /* Slightly translucent over the elevation ring rather than a flat panel
       with a border of its own: the stack sits over a terminal, and reading as
       something above it is the whole job. */
    background: color-mix(in srgb, var(--color-surface-2) 94%, transparent);
    backdrop-filter: blur(10px);
    box-shadow: var(--shadow-e3);
    /* The only chromatic thing on the card, and it fades out before the text
       starts, so the kind is legible without tinting what has to be read. */
    background-image: linear-gradient(
      100deg,
      color-mix(in srgb, var(--toast-accent) 13%, transparent),
      transparent 42%
    );
    --toast-accent: var(--color-muted-foreground);
  }
  .toast.success {
    --toast-accent: var(--color-success);
  }
  .toast.warning {
    --toast-accent: var(--color-warning);
  }
  .toast.error {
    --toast-accent: var(--color-danger);
  }
  /* Sized in em against the message it marks, so the UI scale moves the dot and
     the line it sits on together. In px it drifted off the first line as soon
     as the zoom slider left 100%. */
  .dot {
    width: 0.42em;
    height: 0.42em;
    font-size: var(--text-sm);
    border-radius: 999px;
    background: var(--toast-accent);
    /* Optically on the first line's baseline rather than its box top. */
    margin-top: 0.55em;
    box-shadow: 0 0 0 0.25em color-mix(in srgb, var(--toast-accent) 14%, transparent);
  }
  .lines {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .message {
    font-size: var(--text-sm);
    color: var(--color-foreground);
    /* Errors are the messages users actually need to read, so let them wrap up
       to 3 lines instead of truncating on one. */
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: var(--text-2xs);
    line-height: 1.5;
    color: var(--color-muted-foreground);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .dismiss {
    pointer-events: auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    /* Reserved, not conditional: the button appearing on hover used to reflow
       the text beside it. */
    margin: -3px -3px 0 0;
    padding: 4px;
    border-radius: var(--radius-xs);
    color: var(--color-muted-foreground);
    opacity: 0;
    transition: opacity var(--dur-1) ease, background-color var(--dur-1) ease;
  }
  /* Shown on hover on a pointer device, always shown when the card cannot expire
     on its own or when there is no hover to give (touch). */
  .toast:hover .dismiss,
  .dismiss:focus-visible,
  .toast.sticky .dismiss {
    opacity: 1;
  }
  @media (hover: none) {
    .dismiss {
      opacity: 1;
    }
  }
  .dismiss:hover {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }
</style>
