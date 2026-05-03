<script lang="ts">
  import { paneStore, MAX_LEAVES } from "./store.svelte";

  const preview = $derived(paneStore.dropPreview);
  const rect = $derived(
    preview ? paneStore.rects[preview.targetThreadId] ?? null : null,
  );

  const snap = $derived.by(() => {
    if (!preview || !rect) return null;
    const inset = 4;
    switch (preview.side) {
      case "left":
        return {
          x: rect.x + inset,
          y: rect.y + inset,
          w: rect.w / 2 - inset * 2,
          h: rect.h - inset * 2,
        };
      case "right":
        return {
          x: rect.x + rect.w / 2 + inset,
          y: rect.y + inset,
          w: rect.w / 2 - inset * 2,
          h: rect.h - inset * 2,
        };
      case "top":
        return {
          x: rect.x + inset,
          y: rect.y + inset,
          w: rect.w - inset * 2,
          h: rect.h / 2 - inset * 2,
        };
      case "bottom":
        return {
          x: rect.x + inset,
          y: rect.y + rect.h / 2 + inset,
          w: rect.w - inset * 2,
          h: rect.h / 2 - inset * 2,
        };
    }
  });

  const refused = $derived(preview?.refused ?? false);
</script>

{#if snap}
  <div
    class="snap-preview"
    class:refused
    style:left="{snap.x}px"
    style:top="{snap.y}px"
    style:width="{snap.w}px"
    style:height="{snap.h}px"
    aria-hidden="true"
  >
    {#if refused}
      <span class="refused-label">Max {MAX_LEAVES} panes</span>
    {/if}
  </div>
{/if}

<style>
  .snap-preview {
    position: absolute;
    z-index: 30;
    pointer-events: none;
    border-radius: 8px;
    border: 1px solid rgba(250, 250, 250, 0.55);
    background: color-mix(in srgb, var(--color-foreground, #fafafa) 14%, transparent);
    backdrop-filter: blur(14px) saturate(1.05);
    -webkit-backdrop-filter: blur(14px) saturate(1.05);
    box-shadow:
      inset 0 0 0 1px rgba(255, 255, 255, 0.08),
      0 14px 32px rgba(0, 0, 0, 0.36);
    transition:
      left 160ms cubic-bezier(0.22, 1, 0.36, 1),
      top 160ms cubic-bezier(0.22, 1, 0.36, 1),
      width 160ms cubic-bezier(0.22, 1, 0.36, 1),
      height 160ms cubic-bezier(0.22, 1, 0.36, 1),
      background 120ms,
      border-color 120ms;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .snap-preview.refused {
    border-color: rgba(248, 113, 113, 0.7);
    background: color-mix(in srgb, var(--color-danger, #f87171) 16%, transparent);
  }
  .refused-label {
    border-radius: 6px;
    border: 1px solid rgba(248, 113, 113, 0.5);
    background: rgba(10, 10, 10, 0.7);
    padding: 5px 10px;
    font-size: 11px;
    font-weight: 600;
    color: var(--color-danger, #f87171);
  }
</style>
