<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
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

  /**
   * The same 48 ms gate as the markdown next door: while the reasoning streams,
   * the text node is rewritten at most twenty times a second instead of on
   * every token. What is not live lands at once.
   */
  const MIN_GAP_MS = 48;

  let body = $state('');
  let timer = 0;
  let writtenAt = 0;

  $effect(() => {
    void text;
    if (!live) {
      if (timer) clearTimeout(timer);
      timer = 0;
      body = text;
      return;
    }
    if (timer) return;
    const wait = Math.max(0, MIN_GAP_MS - (performance.now() - writtenAt));
    timer = window.setTimeout(() => {
      timer = 0;
      writtenAt = performance.now();
      body = text;
    }, wait);
  });

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });
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

  <div class="fold" class:open inert={!open}>
    <div class="clip">
      {#if built}
        <p class="body" data-testid="thinking-text">{body}</p>
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
    height: var(--control-sm);
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
