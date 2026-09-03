<script lang="ts">
  import { highlightSegments } from "./fuzzy";

  interface Props {
    text: string;
    ranges?: [number, number][];
  }

  const { text, ranges }: Props = $props();
  const segments = $derived(highlightSegments(text, ranges));
</script>

{#each segments as seg}{#if seg.matched}<mark class="bg-accent/25 text-inherit rounded-[2px]">{seg.text}</mark>{:else}{seg.text}{/if}{/each}
