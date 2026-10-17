<script lang="ts">
  import { GAP } from '../lib/message-window';
  import { gapHeight } from '../lib/history-gaps';

  /** A stretch of the thread not read yet, as tall as its messages are estimated (`lib/history-gaps.ts`). */
  let { from, count }: { from: number; count: number } = $props();
</script>

<!-- Prompts and answers drawn by two masks alone, four estimated slots per tile: no node per message, no animation. -->
<div class="gap" style:height="{gapHeight(count) - GAP}px" data-testid="timeline-gap" data-from={from} data-count={count} aria-busy="true"></div>

<style>
  /* Each tile is four 80 px slots (ESTIMATE): a prompt, an answer, a prompt, an answer.
     Shapes stay in a slot's first 60 px, so the last slot, cut by GAP, is never clipped. */
  .gap {
    position: relative;
    flex: 0 0 auto;
    --tile: 100% 320px;
  }

  .gap::before,
  .gap::after {
    content: '';
    position: absolute;
    inset: 0;
    -webkit-mask-size: var(--tile);
    mask-size: var(--tile);
    -webkit-mask-repeat: repeat-y;
    mask-repeat: repeat-y;
  }

  /* Prompt bubbles on the right, with the bubble's squared corner under its tail. */
  .gap::before {
    background: var(--color-accent-soft);
    opacity: 0.55;
    --bubbles: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='320'><svg x='64%' width='36%' height='40'><rect width='100%' height='40' rx='18'/><svg x='50%' y='18' width='50%' height='22'><rect width='100%' height='22' rx='6'/></svg></svg><svg x='50%' y='160' width='50%' height='40'><rect width='100%' height='40' rx='18'/><svg x='50%' y='18' width='50%' height='22'><rect width='100%' height='22' rx='6'/></svg></svg></svg>");
    -webkit-mask-image: var(--bubbles);
    mask-image: var(--bubbles);
  }

  /* Answers on the left: a few text lines of uneven length. */
  .gap::after {
    background: var(--color-surface-3);
    --lines: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='320'><rect y='84' width='94%' height='10' rx='5'/><rect y='104' width='86%' height='10' rx='5'/><rect y='124' width='58%' height='10' rx='5'/><rect y='244' width='90%' height='10' rx='5'/><rect y='264' width='42%' height='10' rx='5'/></svg>");
    -webkit-mask-image: var(--lines);
    mask-image: var(--lines);
  }
</style>
