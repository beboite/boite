<script lang="ts">
  import { Brain, ChevronRight } from '@lucide/svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { ParagraphScan, currentThought } from '../lib/message-display';
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
  // One block per paragraph, like Prose: a new paragraph renders alone and the
  // earlier ones keep their nodes, folded or not.
  const scan = new ParagraphScan();
  let blocks = $derived(scan.blocks(current.text, live));
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
    <span class="glyph"><Brain size={15} strokeWidth={1.75} /></span>
    <span class="label">{strings.chat.thinking}</span>
    {#if live}
      <span class="dot" aria-label={strings.chat.streaming}></span>
    {/if}
    <span class="caret" class:open aria-hidden="true"><ChevronRight size={12} strokeWidth={2} /></span>
  </button>

  <div class="fold" class:open inert={!open}>
    <div class="clip">
      {#if built}
        <div class="body" data-testid="thinking-text">
          {#if blocks.length === 0 && current.title}<div class="paragraph">{current.title}</div>{/if}
          {#each blocks as block, index (index)}<div class="paragraph">{@html renderMarkdown(block)}</div>{/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .thinking {
    max-width: 100%;
    padding-left: var(--activity-padding);
    margin-bottom: var(--chat-part-gap);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--activity-gap);
    min-height: var(--control);
    height: auto;
    max-width: 100%;
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .glyph { display: inline-flex; flex: none; width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }

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
    font-weight: 400;
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
    margin: 4px 0 8px calc(var(--activity-padding) + var(--activity-glyph) / 2);
    padding: 4px var(--activity-padding) 4px calc(var(--activity-glyph) / 2 + var(--activity-gap));
    border-left: 1px solid var(--color-border);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* An endless loop stops under reduced motion; the static mark keeps its colour. */
  @media (prefers-reduced-motion: reduce) { .dot { animation: none; } }
  :global(html[data-motion='reduced']) .dot { animation: none; }
</style>
