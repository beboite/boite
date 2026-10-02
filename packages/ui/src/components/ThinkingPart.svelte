<script lang="ts">
  import { Brain, ChevronRight } from '@lucide/svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { ParagraphScan } from '../lib/message-display';
  import { strings } from '../lib/strings';
  import { elapsed } from '../lib/format';

  let { text, live = false, startedAt = null, finishedAt = null }: { text: string; live?: boolean; startedAt?: number | null; finishedAt?: number | null } = $props();

  let now = $state(Date.now());
  let hidden = $state(document.hidden);
  $effect(() => {
    if (!live || startedAt === null || hidden) return;
    now = Date.now();
    const timer = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(timer);
  });
  const took = $derived(startedAt === null || (!live && finishedAt === null) ? '' : elapsed((live ? now : finishedAt!) - startedAt));

  // Folded by default, and the fold belongs to this part alone.
  let open = $state(false);
  const empty = $derived(text.trim().length === 0);
  const shown = $derived(open && !empty);

  // Built on the first open, then folded rather than thrown away: that is what
  // gives the height something to animate on the way back.
  let built = $state(false);
  $effect(() => {
    if (open) built = true;
  });

  // One block per paragraph, like Prose: a new paragraph renders alone and the
  // earlier ones keep their nodes, folded or not.
  const scan = new ParagraphScan();
  const content = $derived.by(() => {
    const blocks = scan.blocks(text, live);
    return { blocks, pending: live ? scan.pending(text) : '' };
  });
</script>

<svelte:document onvisibilitychange={() => hidden = document.hidden} />

<div class="thinking" data-testid="thinking-part">
  <button
    type="button"
    class="ghost head"
    data-testid="thinking-toggle"
    aria-expanded={empty ? undefined : shown}
    title={empty ? undefined : shown ? strings.chat.thinkingHide : strings.chat.thinkingShow}
    onclick={() => (open = !open)}
  >
    <span class="glyph"><Brain size={15} strokeWidth={1.75} /></span>
    <span class="label">{strings.chat.thinking}</span>
    {#if took}<span class="took" data-testid="thinking-elapsed">{took}</span>{/if}
    {#if live}
      <span class="dot" aria-label={strings.chat.streaming}></span>
    {/if}
    {#if !empty}<span class="caret" class:open={shown} aria-hidden="true"><ChevronRight size={12} strokeWidth={2} /></span>{/if}
  </button>

  <div class="fold" class:open={shown} inert={!shown}>
    <div class="clip">
      {#if built}
        <div class="body" data-testid="thinking-text">
          {#each content.blocks as block, index (index)}<div class="paragraph">{@html renderMarkdown(block)}</div>{/each}
          {#if content.pending}<div class="paragraph">{content.pending}</div>{/if}
        </div>
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
    gap: var(--activity-gap);
    min-height: var(--control);
    height: auto;
    max-width: 100%;
    padding: var(--activity-padding);
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
  }

  .glyph { display: inline-flex; flex: none; width: var(--activity-glyph); justify-content: center; color: var(--color-subtle); }
  .took { flex: none; color: var(--color-subtle); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }

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
