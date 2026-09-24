<script lang="ts">
  import type { PreviewReference } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { promptSegments } from '../lib/message-display';
  import { previewTextParts } from '../lib/preview-mentions';
  import { strings } from '../lib/strings';

  let { text = '', references, store, threadId, editing = false, keywords = false, onreference }: {
    text?: string;
    references: PreviewReference[];
    store: Store;
    threadId: string;
    editing?: boolean;
    /** Paint Claude Code's prompt keywords in the text around the references. */
    keywords?: boolean;
    onreference?: (reference: PreviewReference) => void;
  } = $props();
  const parts = $derived(previewTextParts(text, references));

  function reveal(reference: PreviewReference) {
    onreference?.(reference);
    void store.revealPreviewReference(threadId, reference);
  }
</script>

<span class="references" class:editing data-testid="preview-references">{#each parts as part, index (index)}{#if part.reference}{@const reference = part.reference}<span role="button" tabindex="0" class="element" data-testid="preview-reference" data-reference-id={reference.id}
  title={`${strings.previewComments.reveal}\n${reference.url}\n${reference.selector}`}
  onpointerdown={(event) => { if (editing) event.preventDefault(); }}
  onclick={() => reveal(reference)}
  onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); reveal(reference); } }}>{part.text}</span>{:else}<span aria-hidden={editing}>{#each promptSegments(part.text, undefined, keywords) as segment, at (at)}{#if segment.kind === 'plain'}{segment.text}{:else}<span class="keyword-{segment.kind}" data-testid="keyword-highlight">{segment.text}</span>{/if}{/each}</span>{/if}{/each}</span>

<style>
  .references { white-space: pre-wrap; overflow-wrap: break-word; }
  .element { color: var(--color-accent); font-weight: 700; cursor: pointer; border-radius: var(--radius-sm); }
  .element:hover { background: var(--color-accent-soft); }
  .element:focus-visible { outline: 1px solid var(--color-accent); outline-offset: 2px; }
  /* Synthetic weight retains the textarea's exact glyph widths and wrapping. */
  .editing .element { font-weight: inherit; -webkit-text-stroke: 0.35px currentColor; pointer-events: auto; }
</style>
