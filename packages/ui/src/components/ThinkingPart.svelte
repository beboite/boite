<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import { strings } from '../lib/strings';

  let { text, live = false }: { text: string; live?: boolean } = $props();

  // Folded by default, and the fold belongs to this part alone.
  let open = $state(false);
</script>

<div class="thinking" data-testid="thinking-part">
  <button
    type="button"
    class="ghost head"
    data-testid="thinking-toggle"
    aria-expanded={open}
    title={open ? strings.chat.thinkingHide : strings.chat.thinkingShow}
    onclick={() => (open = !open)}
  >
    <span class="caret" class:open><ChevronRight size={13} strokeWidth={2} /></span>
    <span class="label">{strings.chat.thinking}</span>
    {#if live}
      <span class="dot" aria-label={strings.chat.streaming}></span>
    {/if}
  </button>

  {#if open}
    <p class="body" data-testid="thinking-text">{text}</p>
  {/if}
</div>

<style>
  .thinking {
    max-width: 100%;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 8px 0 4px;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .head:hover:not(:disabled) {
    color: var(--color-foreground);
  }

  .caret {
    display: inline-flex;
    color: var(--color-subtle);
    transition: transform var(--dur-2) var(--ease-out-quint);
  }

  .caret.open {
    transform: rotate(90deg);
  }

  .label {
    font-weight: 500;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .body {
    margin: 2px 0 0 8px;
    padding: 8px;
    border-left: 2px solid var(--color-border);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
