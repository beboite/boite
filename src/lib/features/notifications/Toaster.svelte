<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { settings } from "$lib/features/settings/store.svelte";
  import { notifications } from "./store.svelte";
  import Toast from "./Toast.svelte";

  // Bottom-right on desktop. On a phone that corner belongs to the keyboard FAB
  // and the bottom bar, and a toast parked on top of them swallowed every tap on
  // the only way to raise the keyboard, so the stack moves to the top instead.
  const mobile = $derived(settings.state.mobileLayout);
</script>

<!-- No aria-live on the container. It used to be one polite atomic region, so
     every new toast re-announced the whole stack and errors waited their turn;
     each card now carries its own role instead (alert for errors, status for
     the rest). -->
<div
  class="toaster pointer-events-none fixed z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5"
  class:toaster-top={mobile}
>
  {#each notifications.toasts as toast (toast.id)}
    <div animate:flip={{ duration: 150 }} transition:fly={{ y: mobile ? -8 : 8, duration: 150 }}>
      <!-- A repeat of the same message bumps resetKey rather than stacking a
           second card; remounting here is what restarts its countdown. -->
      {#key toast.resetKey}
        <Toast
          message={toast.message}
          kind={toast.kind}
          durationMs={toast.durationMs}
          onDone={() => notifications.dismiss(toast.id)}
        />
      {/key}
    </div>
  {/each}
</div>

<style>
  .toaster {
    right: 1rem;
    bottom: calc(1rem + env(safe-area-inset-bottom, 0px));
  }
  .toaster.toaster-top {
    bottom: auto;
    top: calc(1rem + env(safe-area-inset-top, 0px));
  }
</style>
