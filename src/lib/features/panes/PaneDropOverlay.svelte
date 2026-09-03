<script lang="ts">
  import { t } from "$lib/i18n/index.svelte";
  import { paneStore, MAX_LEAVES } from "./store.svelte";

  const preview = $derived(paneStore.dropPreview);
  const rect = $derived(
    preview ? paneStore.rects[preview.targetPaneId] ?? null : null,
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
      <span class="refused-label">{t("panes.maxReached", { count: MAX_LEAVES })}</span>
    {/if}
  </div>
{/if}

<style>
  .snap-preview {
    position: absolute;
    z-index: var(--z-drop);
    pointer-events: none;
    border-radius: 8px;
    /* Mixed off --color-foreground rather than written out: the preview is a
       pane-shaped hole of the opposite tone, and a fixed near-white is a white
       rectangle on a white background under the light palette. */
    border: 1px solid color-mix(in srgb, var(--color-foreground) 55%, transparent);
    background: color-mix(in srgb, var(--color-foreground) 14%, transparent);
    backdrop-filter: blur(14px) saturate(1.05);
    -webkit-backdrop-filter: blur(14px) saturate(1.05);
    box-shadow:
      inset 0 0 0 1px color-mix(in srgb, var(--color-foreground) 8%, transparent),
      var(--shadow-e3);
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
    border-color: color-mix(in srgb, var(--color-danger) 70%, transparent);
    background: color-mix(in srgb, var(--color-danger) 16%, transparent);
  }
  .refused-label {
    border-radius: 6px;
    border: 1px solid color-mix(in srgb, var(--color-danger) 50%, transparent);
    background: color-mix(in srgb, var(--color-background) 70%, transparent);
    padding: 5px 10px;
    font-size: var(--text-xs);
    font-weight: 600;
    color: var(--color-danger);
  }
</style>
