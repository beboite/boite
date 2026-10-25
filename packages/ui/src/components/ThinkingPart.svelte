<script lang="ts">
  import { secondClock } from '../lib/clock.svelte';
  import { Brain, ChevronRight } from '@lucide/svelte';
  import { renderMarkdown } from '../lib/markdown';
  import { workspace } from '../lib/workspace.svelte';
  import { ParagraphScan } from '../lib/message-display';
  import { strings } from '../lib/strings';
  import { elapsed } from '../lib/format';
  import { ThoughtTitleScan } from '../lib/tool-groups';
  import type { Store } from '../lib/store.svelte';
  import { richMarkdown } from '../lib/rich-markdown';
  import { viewerHost } from '../lib/media-gallery';

  /** `store` and `threadId` say where a thread link in the reasoning starts from. */
  let { text, live = false, startedAt = null, finishedAt = null, store, threadId }: { text: string; live?: boolean; startedAt?: number | null; finishedAt?: number | null; store?: Store; threadId?: string } = $props();

  const took = $derived(startedAt === null || (!live && finishedAt === null) ? '' : elapsed((live ? secondClock.now : finishedAt!) - startedAt));
  // A diagram in the reasoning opens in the timeline's viewer.
  const viewers = viewerHost();

  // Folded by default, and the fold belongs to this part alone.
  let open = $state(false);
  const empty = $derived(text.trim().length === 0);
  // What the step is about ("Inspecting the driver"), the plain word while it has none.
  // The scan resumes where the last delta left off.
  const titles = new ThoughtTitleScan();
  const label = $derived(titles.title(text) ?? strings.chat.thinking);
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
    <span class="label ui-label" data-testid="thinking-label" title={empty ? undefined : label}>{label}</span>
    {#if took}<span class="took ui-label" data-testid="thinking-elapsed">{took}</span>{/if}
    {#if live}
      <span class="dot" aria-label={strings.chat.streaming}></span>
    {/if}
    {#if !empty}<span class="fold-caret" class:open={shown} aria-hidden="true"><ChevronRight size={12} /></span>{/if}
  </button>

  <div class="disclosure-fold" class:open={shown} inert={!shown}>
    <div>
      {#if built}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="body" data-testid="thinking-text" use:richMarkdown={{ onenlarge: viewers ? item => { viewers.open({ items: [item], index: 0 }); viewers.release(item.src); } : undefined }} onclick={event => workspace.followThreadLink(event, store, threadId)}>
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

  .label {
    /* A thought's title can be a whole sentence: it shrinks to an ellipsis, the time and caret stay. */
    flex: 0 1 auto;
    min-width: 0;
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
    animation: pulse 1.6s var(--loop-ease-in-out-48) infinite var(--loops);
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
