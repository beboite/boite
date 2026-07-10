<script lang="ts">
  import { spinnerTicker, TICKER_BASE_MS } from "$lib/shared/utils/ticker.svelte";

  type Props = {
    frames?: string[];
    intervalMs?: number;
    size?: number;
  };
  let {
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs = 80,
    size = 12,
  }: Props = $props();

  $effect(() => spinnerTicker.subscribe());

  const step = $derived(Math.max(1, Math.round(intervalMs / TICKER_BASE_MS)));
  const index = $derived(Math.floor(spinnerTicker.tick / step) % frames.length);
</script>

<span
  class="inline-block font-mono leading-none"
  style:font-size="{size}px"
  aria-hidden="true"
>{frames[index]}</span>
