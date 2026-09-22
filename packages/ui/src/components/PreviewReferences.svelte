<script lang="ts">
  import { X } from '@lucide/svelte';
  import type { PreviewReference } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { previewReferenceLabel } from '../lib/preview-comments';
  import { strings } from '../lib/strings';

  let { references, store, threadId, onremove }: {
    references: PreviewReference[];
    store: Store;
    threadId: string;
    onremove?: (id: string) => void;
  } = $props();
</script>

<div class="references" data-testid="preview-references">
  {#each references as reference (reference.id)}
    <span class="reference">
      <button type="button" class="element" data-testid="preview-reference" title={`${strings.previewComments.reveal}\n${reference.url}\n${reference.selector}`}
        onclick={() => void store.revealPreviewReference(threadId, reference)}>{previewReferenceLabel(reference)}</button>
      {#if onremove}
        <button type="button" class="remove" data-testid="preview-reference-remove" aria-label={strings.previewComments.remove} title={strings.previewComments.remove}
          onclick={() => onremove?.(reference.id)}><X size={12} /></button>
      {/if}
    </span>
  {/each}
</div>

<style>
  .references { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
  .reference { display: inline-flex; align-items: center; max-width: 100%; border-radius: var(--radius-sm); background: var(--color-accent-soft); }
  .element, .remove { color: var(--color-accent); background: transparent; border: none; height: var(--control-sm); }
  .element { font-weight: 700; font-size: var(--text-sm); padding: 0 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .remove { flex: none; width: var(--control-sm); padding: 0; }
  .element:hover, .remove:hover { background: var(--color-hover); }
</style>
