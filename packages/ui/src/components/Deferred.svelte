<script lang="ts" module>
  export { parts } from '../lib/deferred-parts';
</script>

<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  import type { LazyComponent } from '../lib/lazy-component.svelte';
  import { retryOrReload } from '../lib/retry-load';
  import { strings } from '../lib/strings';

  /**
   * Draws a part of `lib/deferred-parts.ts` once its chunk is here, and asks
   * for it when mounted. Most parts are prefetched at idle and land before
   * anyone opens them; one asked for before that (a link that saves data
   * skips the prefetch) says it is loading, and one whose chunk failed says so
   * with a retry. `pending` replaces both when the place must keep its own
   * look (a button in a bar), and `quiet` draws nothing for a part that only
   * decorates (a face, a notice). Any failed part asks again once the browser
   * is back online; Retry loads a fresh page when asking again fails at once
   * (`lib/retry-load.ts`). `floating` is for a part that covers the screen (the image
   * viewer): its notice floats above the page instead of sitting in the flow.
   */
  let { part, children, pending, quiet = false, floating = false }: {
    part: LazyComponent<T>;
    children: Snippet<[T]>;
    pending?: Snippet;
    quiet?: boolean;
    floating?: boolean;
  } = $props();

  function load(): void {
    void part.load().catch(() => undefined);
  }

  $effect(load);
</script>

<svelte:window ononline={() => { if (part.failed) load(); }} />

{#if part.current}
  {@render children(part.current)}
{:else if pending}
  {@render pending()}
{:else if quiet}
  <!-- Nothing: the place reads the same without it. -->
{:else if part.failed}
  <p class="deferred" class:floating role="alert" data-testid="deferred-failed">
    <span>{strings.parts.failed}</span>
    <button type="button" data-testid="deferred-retry" onclick={() => void retryOrReload(() => part.load())}>{strings.common.retry}</button>
  </p>
{:else}
  <p class="deferred" class:floating role="status" aria-busy="true" data-testid="deferred-loading">{strings.parts.loading}</p>
{/if}

<style>
  .deferred { display: flex; align-items: center; gap: 10px; margin: 0; min-height: var(--control-sm); color: var(--color-muted-foreground); }
  .deferred.floating { position: fixed; left: 50%; bottom: 24px; z-index: 50; transform: translateX(-50%); padding: 8px 14px; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); }
  .deferred[role=alert] span { color: var(--color-danger); }
  .deferred button { flex: none; min-height: var(--control-sm); padding: 0 10px; border-radius: var(--radius-md); }
</style>
