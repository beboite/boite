<script lang="ts">
  import { fill, strings } from '../lib/strings';
  import { transferBytes } from '../lib/format';

  /**
   * What the chat shows between the click on a thread and its first page: a
   * bar and how much of the page arrived against what the core said it
   * weighs. Until the core says (a page short enough to come whole, or a core
   * that sends answers whole) the bar runs without a number.
   */
  let { progress }: { progress: { received: number; total: number } | null } = $props();

  const fraction = $derived(progress && progress.total > 0 ? Math.min(1, progress.received / progress.total) : null);
  const label = $derived(progress ? fill(strings.chat.openingProgress, { received: transferBytes(progress.received), total: transferBytes(progress.total) }) : '');
</script>

<div class="loading" data-testid="thread-loading" role="status" aria-live="polite">
  <div class="stack">
    <div class="track" role="progressbar" aria-label={strings.chat.opening}
      aria-valuemin={0} aria-valuemax={progress?.total} aria-valuenow={progress?.received} aria-valuetext={label || undefined}>
      {#if fraction === null}
        <div class="bar sweep" data-testid="thread-loading-sweep"></div>
      {:else}
        <div class="bar" data-testid="thread-loading-bar" style:transform="scaleX({fraction})"></div>
      {/if}
    </div>
    <p class="caption">
      <span>{strings.chat.opening}</span>
      {#if label}<span class="numbers" data-testid="thread-loading-progress">{label}</span>{/if}
    </p>
  </div>
</div>

<style>
  .loading {
    flex: 1;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px 20px;
    /* A fast open finishes before this shows: no flash for a short page. */
    animation: fade var(--dur-3) var(--ease-out-quint) 150ms both;
  }

  .stack {
    width: min(360px, 100%);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .track {
    position: relative;
    height: 4px;
    border-radius: 999px;
    background: var(--color-surface-3);
    overflow: hidden;
  }

  .bar {
    height: 100%;
    width: 100%;
    border-radius: 999px;
    background: var(--color-accent);
    transform-origin: left;
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  /* No total yet: a third of the track crossing it, by transform alone. */
  .bar.sweep {
    width: 33%;
    animation: sweep 1.2s var(--ease-in-out, ease-in-out) infinite;
  }

  @keyframes sweep {
    from { transform: translateX(-100%); }
    to { transform: translateX(300%); }
  }

  .caption {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .numbers {
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  @media (prefers-reduced-motion: reduce) {
    .bar.sweep { animation: none; width: 100%; opacity: 0.5; }
  }
</style>
