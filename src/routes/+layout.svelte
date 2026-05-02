<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  import { app } from "$lib/app/store.svelte";
  import { settings } from "$lib/features/settings/store.svelte";

  let { children } = $props();

  $effect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.style.fontSize = `${settings.state.uiScalePercent}%`;
  });

  function handleWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -5 : 5;
    void settings.setUiScalePercent(settings.state.uiScalePercent + delta);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!e.ctrlKey) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      void settings.setUiScalePercent(settings.state.uiScalePercent + 5);
    } else if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      void settings.setUiScalePercent(settings.state.uiScalePercent - 5);
    } else if (e.key === "0") {
      e.preventDefault();
      void settings.setUiScalePercent(100);
    }
  }

  onMount(() => {
    void app.init();
  });
</script>

<svelte:window onwheel={handleWheel} onkeydown={handleKeydown} />

{@render children()}
