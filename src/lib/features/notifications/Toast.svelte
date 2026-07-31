<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "$lib/i18n/index.svelte";
  import X from "@lucide/svelte/icons/x";
  import type { ToastKind } from "./store.svelte";

  type Props = {
    message: string;
    durationMs?: number | null;
    kind?: ToastKind;
    onDone: () => void;
  };
  let {
    message,
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
  class:error={kind === "error"}
  class:sticky
  role={kind === "error" ? "alert" : "status"}
>
  <div class="accent"></div>
  <div class="body">
    <svg
      class="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {#if kind === "success"}
        <path d="M20 6L9 17l-5-5" />
      {:else if kind === "error"}
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      {:else}
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      {/if}
    </svg>
    <span class="text">{message}</span>
    <button
      type="button"
      class="dismiss"
      onclick={onDone}
      aria-label={t("common.dismiss")}
      title={t("common.dismiss")}
    >
      <X class="size-3" />
    </button>
  </div>
</div>

<style>
  /* pointer-events only on the button. The whole card used to take them with no
     handler behind it, which on a phone parked a dead 320px target on top of the
     keyboard FAB for as long as the toast lasted. */
  .toast {
    pointer-events: none;
    display: flex;
    overflow: hidden;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: 6px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    --toast-accent: var(--color-muted-foreground);
  }
  .toast.success {
    --toast-accent: var(--color-success);
  }
  .toast.error {
    --toast-accent: var(--color-danger);
  }
  .accent {
    width: 3px;
    flex-shrink: 0;
    background: var(--toast-accent);
  }
  .body {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    min-width: 0;
    flex: 1;
  }
  .icon {
    flex-shrink: 0;
    color: var(--toast-accent);
  }
  .text {
    flex: 1;
    min-width: 0;
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
  .dismiss {
    pointer-events: auto;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: flex-start;
    margin: -2px -4px 0 0;
    padding: 4px;
    border-radius: 4px;
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
