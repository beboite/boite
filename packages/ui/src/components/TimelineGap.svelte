<script lang="ts">
  import { GAP } from '../lib/message-window';
  import { gapHeight } from '../lib/history-gaps';

  /** A stretch of the thread not read yet, as tall as its messages are estimated (`lib/history-gaps.ts`). */
  let { from, count }: { from: number; count: number } = $props();
</script>

<!-- A prompt and an answer per estimated slot, drawn by the background alone: no node per message, no animation. -->
<div class="gap" style:height="{gapHeight(count) - GAP}px" data-testid="timeline-gap" data-from={from} data-count={count} aria-busy="true"></div>

<style>
  .gap {
    flex: 0 0 auto;
    opacity: 0.6;
    background:
      linear-gradient(to bottom, var(--color-surface-2) 0 16px, transparent 16px 80px) right 0 / 38% 80px repeat-y,
      linear-gradient(to bottom, transparent 0 32px, var(--color-surface-2) 32px 42px, transparent 42px 80px) left 0 / 72% 80px repeat-y;
  }
</style>
