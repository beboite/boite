<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { notifications } from "./store.svelte";
  import { toastAnchor } from "./anchor.svelte";
  import Toast from "./Toast.svelte";

  // Top-right of the work area, both layouts. Bottom-right was the desktop
  // corner the docked git/files/todo column ends in, and on a phone it belongs
  // to the keyboard FAB and the bottom bar.
  //
  // The anchor is the measured `<main>`, so the stack stays clear of the
  // sidebar and of the docked panel. Null on the login and setup screens, which
  // draw no `<main>`: the CSS corner below is what they get. A panel someone
  // detached into a pane of the terminal area is not dodged, only the docked
  // column is.
  const anchor = $derived(toastAnchor.box);
</script>

<!-- No aria-live on the container. It used to be one polite atomic region, so
     every new toast re-announced the whole stack and errors waited their turn;
     each card now carries its own role instead (alert for errors, status for
     the rest). -->
<div
  class="toaster pointer-events-none fixed z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5"
  style:top={anchor ? `calc(${anchor.top}px + 0.75rem)` : null}
  style:right={anchor ? `calc(${anchor.right}px + 0.75rem)` : null}
>
  {#each notifications.toasts as toast (toast.id)}
    <div animate:flip={{ duration: 150 }} transition:fly={{ y: -8, duration: 150 }}>
      <!-- A repeat of the same message bumps resetKey rather than stacking a
           second card; remounting here is what restarts its countdown. -->
      {#key toast.resetKey}
        <Toast
          message={toast.message}
          detail={toast.detail}
          kind={toast.kind}
          durationMs={toast.durationMs}
          onDone={() => notifications.dismiss(toast.id)}
        />
      {/key}
    </div>
  {/each}
</div>

<style>
  /* Overridden inline as soon as the work area has been measured; this is the
     window corner the login and setup screens use. */
  .toaster {
    right: 1rem;
    top: calc(1rem + env(safe-area-inset-top, 0px));
  }
</style>
