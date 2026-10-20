<script lang="ts">
  import { fingerprintWords } from '../../lib/contacts.svelte';

  /** The eight words both owners compare, drawn as keycaps so they read one by one. */
  let { fingerprint, testid }: { fingerprint: string; testid?: string } = $props();
  const words = $derived(fingerprintWords(fingerprint));
</script>

<div class="fit">
  <ol class="words" data-testid={testid}>
    {#each words as word, index (index)}
      <li class="word" style:--i={index}><span class="n" aria-hidden="true">{index + 1}</span><span class="w">{word}</span></li>
    {/each}
  </ol>
</div>

<style>
  /* Two rows of four, or four rows of two on a narrow card. */
  .fit { container-type: inline-size; }
  .words { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin: 0; padding: 0; list-style: none; }
  @container (min-width: 440px) { .words { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  .word {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 40px;
    padding: 6px 10px 8px;
    border: 1px solid var(--color-edge);
    border-bottom-width: 3px;
    border-radius: var(--radius-md);
    background: linear-gradient(to bottom, var(--color-surface-3), var(--color-surface-2));
    box-shadow: var(--shadow-e1);
    animation: rise var(--dur-3) var(--ease-out-quint) both;
    animation-delay: calc(var(--i) * 40ms);
  }
  .n { position: absolute; top: 3px; left: 6px; color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
  .w { font-family: var(--font-mono); font-size: var(--text-base); font-weight: 600; letter-spacing: 0.02em; color: var(--color-foreground); }
  @media (prefers-reduced-motion: reduce) { .word { animation: none; } }
  :global(html[data-motion='reduced']) .word { animation: none; }
</style>
