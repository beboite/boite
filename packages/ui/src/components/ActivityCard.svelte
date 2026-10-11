<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Elapsed from './Elapsed.svelte';

  /**
   * Work the agent started, as a card in the chat where it started: a mark,
   * a heading, its progress and how long it has run. Clicking opens the panel
   * that follows it; the button's own attributes pass through.
   */
  let { live, heading, timing, mark, progress, extra, progressTestId, ...button }: Omit<HTMLButtonAttributes, 'children'> & {
    live: boolean;
    heading: string;
    /** No start yet means no clock. */
    timing: { startedAt: number | null; finishedAt: number | null; active: boolean };
    mark: Snippet;
    progress: Snippet;
    /** A line under the progress, such as the workflow's phases. */
    extra?: Snippet;
    /** Test hook on the progress line, beside the card's own data-testid. */
    progressTestId?: string;
  } = $props();
</script>

<button type="button" class="activity" class:live {...button}>
  {@render mark()}
  <span class="content">
    <span class="heading">{heading}</span>
    <span class="progress" data-testid={progressTestId}>{@render progress()}</span>
    {@render extra?.()}
  </span>
  <span class="timing">{#if timing.startedAt !== null}<Elapsed startedAt={timing.startedAt} finishedAt={timing.finishedAt} active={timing.active} />{/if}</span>
  <ChevronRight size={15} />
</button>

<style>
  .activity { width: 100%; min-height: var(--row); height: auto; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-surface); box-shadow: var(--shadow-e1); text-align: left; color: var(--color-muted-foreground); font-weight: 400; }
  .activity:hover, .activity:focus-visible { background: var(--color-hover); color: var(--color-foreground); }
  .content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .heading { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); font-size: var(--text-sm); font-weight: 500; }
  .progress { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: var(--text-xs); }
  .live .progress > :global(svg) { color: var(--color-live); }
  .timing { flex: none; font-size: var(--text-xs); }
</style>
