<script lang="ts">
  import { onMount, onDestroy } from "svelte";

  type Props = {
    frames?: string[];
    intervalMs?: number;
    size?: number;
    className?: string;
  };
  let {
    frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs = 80,
    size = 12,
    className = "",
  }: Props = $props();

  let index = $state(0);
  let timer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    timer = setInterval(() => {
      index = (index + 1) % frames.length;
    }, intervalMs);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });
</script>

<span
  class="inline-block font-mono leading-none {className}"
  style:font-size="{size}px"
  aria-hidden="true"
>{frames[index]}</span>
