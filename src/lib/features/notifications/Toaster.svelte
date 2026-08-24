<script lang="ts">
  import { fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { notifications } from "./store.svelte";
  import { toastAnchor } from "./anchor.svelte";
  import Toast from "./Toast.svelte";

  // Gap between the info box and the first card, and the work-area gutter the
  // stack uses when no box is standing.
  const GAP_REM = 0.75;
  const AIR_REM = 0.5;
  // `w-80` below, in rem: the UI scale is a root font-size, so a stack centred
  // on a fixed 320 drifts right by half the scale's surplus on every notch.
  const TOAST_WIDTH_REM = 20;

  const anchor = $derived(toastAnchor.box);
  const claim = $derived(toastAnchor.claim);
  const stack = $derived(claim?.stack ?? "below");

  let vw = $state(typeof window === "undefined" ? 0 : window.innerWidth);
  let vh = $state(typeof window === "undefined" ? 0 : window.innerHeight);
  // Measured, so the `max-w` clamp on a narrow window counts too.
  let measuredWidth = $state(0);

  function onResize() {
    vw = window.innerWidth;
    vh = window.innerHeight;
  }

  function remPx(n: number): number {
    if (typeof window === "undefined") return n * 16;
    const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return n * (Number.isFinite(root) ? root : 16);
  }

  const place = $derived.by(() => {
    const gap = remPx(GAP_REM);
    const air = remPx(AIR_REM);
    const width = measuredWidth > 0 ? measuredWidth : remPx(TOAST_WIDTH_REM);
    if (claim) {
      let top: number | null = null;
      let bottom: number | null = null;
      if (claim.stack === "below") {
        top = claim.bottom + air;
      } else {
        bottom = vh - claim.top + air;
      }
      let left: number | null = null;
      let right: number | null = null;
      if (claim.align === "left") {
        left = claim.left;
      } else if (claim.align === "right") {
        right = vw - claim.right;
      } else {
        left = claim.left + claim.width / 2 - width / 2;
      }
      if (left != null) {
        left = Math.max(gap, Math.min(left, vw - width - gap));
      }
      return { top, right, bottom, left };
    }
    if (anchor) {
      return {
        top: anchor.top + gap,
        right: anchor.right + gap,
        bottom: null,
        left: null,
      };
    }
    return { top: null, right: null, bottom: null, left: null };
  });

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
  class="toaster pointer-events-none fixed z-[var(--z-toast)] flex w-80 max-w-[calc(100vw-2rem)] gap-1.5"
  class:flex-col={stack === "below"}
  class:flex-col-reverse={stack === "above"}
  bind:clientWidth={measuredWidth}
  style:top={place.top != null ? px(place.top) : place.bottom != null ? "auto" : null}
  style:right={place.right != null ? px(place.right) : place.left != null ? "auto" : null}
  style:bottom={px(place.bottom)}
  style:left={px(place.left)}
>
  {#each notifications.toasts as toast (toast.id)}
    <div
      animate:flip={{ duration: 150 }}
      transition:fly={{ y: stack === "above" ? 8 : -8, duration: 150 }}
    >
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
