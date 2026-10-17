<script lang="ts" module>
  export { parts } from '../lib/deferred-parts';
</script>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import type { LazyComponent } from '../lib/lazy-component.svelte';

  /**
   * Draws a part of `lib/deferred-parts.ts` once its chunk is here, and asks
   * for it when mounted. Until then `pending` holds its place, when the place
   * must keep its size (a button in a bar); most parts are prefetched at idle
   * and land before anyone opens them.
   */
  let { part, children, pending }: { part: LazyComponent<T>; children: Snippet<[T]>; pending?: Snippet } = $props();

  $effect(() => {
    void part.load().catch(() => undefined);
  });
</script>

{#if part.current}{@render children(part.current)}{:else}{@render pending?.()}{/if}
