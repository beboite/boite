<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { notifications } from "./store.svelte";
  import { toastAnchor } from "./anchor.svelte";
  import {
    toastPlace,
    TOAST_AIR_REM,
    TOAST_GAP_REM,
    TOAST_WIDTH,
  } from "./place";
  import Toast from "./Toast.svelte";

  const claim = $derived(toastAnchor.claim);
  const area = $derived(toastAnchor.box);

  let vw = $state(typeof window === "undefined" ? 0 : window.innerWidth);

  function onResize() {
    vw = window.innerWidth;
  }

  function remPx(n: number): number {
    if (typeof window === "undefined") return n * 16;
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return n * (Number.isFinite(root) ? root : 16);
  }

  const place = $derived(
    toastPlace({
      claim,
      area,
      vw,
      gap: remPx(TOAST_GAP_REM),
      air: remPx(TOAST_AIR_REM),
      width: TOAST_WIDTH,
    }),
  );

  function px(n: number | null): string | null {
    return n == null ? null : `${n}px`;
  }
</script>

<svelte:window onresize={onResize} />

<!-- No aria-live on the container. It used to be one polite atomic region, so
     every new toast re-announced the whole stack and errors waited their turn;
     each card now carries its own role instead (alert for errors, status for
     the rest). -->
<div
  class="toaster pointer-events-none fixed z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5"
  style:top={px(place.top)}
  style:right={px(place.right)}
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
