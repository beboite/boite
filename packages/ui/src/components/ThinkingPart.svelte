<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { paragraphBlocks, currentThought } from '../lib/message-display';
  import { strings } from '../lib/strings';

  let { text, live = false }: { text: string; live?: boolean } = $props();

  // Folded by default, and the fold belongs to this part alone.
  let open = $state(false);

  // Built on the first open, then folded rather than thrown away: that is what
  // gives the height something to animate on the way back.
  let built = $state(false);
  $effect(() => {
    if (open) built = true;
  });

  let current = $derived(currentThought(text));
  let body = $derived(paragraphBlocks(current.text, live).join('\n\n'));
  let preview = $derived(current.title ?? strings.chat.thinking);
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
    <span class="label">{preview}</span>
    {#if live}
      <span class="dot" aria-label={strings.chat.streaming}></span>
    {/if}
  </button>

  <div class="fold" class:open inert={!open}>
    <div class="clip">
      {#if built}
        <div class="body" data-testid="thinking-text">{@html renderMarkdown(body)}</div>
      {/if}
    </div>
  </div>
</div>

<style>
  .thinking {
    max-width: 100%;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: var(--control-sm);
    height: auto;
    max-width: 100%;
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
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  /* The rows track carries the open and the close, the same trick as the tool card. */
  .fold {
    display: grid;
    grid-template-rows: 0fr;
    opacity: 0;
    transition:
      grid-template-rows var(--dur-3) var(--ease-out-quint),
      opacity var(--dur-3) var(--ease-out-quint);
  }

  .fold.open {
    grid-template-rows: 1fr;
    opacity: 1;
  }

  .clip {
    min-height: 0;
    overflow: hidden;
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
