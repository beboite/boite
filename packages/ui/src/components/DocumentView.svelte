<script lang="ts">
  import type { ToolDocument } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import Deferred, { parts } from './Deferred.svelte';
  import Prose from './Prose.svelte';
  import type { Store } from '../lib/store.svelte';

  /** One document a tool call produced, under the card's input and output. */
  let { doc, store, threadId }: { doc: ToolDocument; store?: Store; threadId?: string } = $props();
</script>

<div class="document" data-testid="tool-document" data-kind={doc.kind}>
  {#if doc.kind === 'diff'}
    <Deferred part={parts.DiffView}>{#snippet children(DiffView)}<DiffView path={doc.path} oldText={doc.oldText} newText={doc.newText} {doc} />{/snippet}</Deferred>
  {:else if doc.kind === 'markdown'}
    {#if doc.title !== null}
      <div class="section-label">{doc.title}</div>
    {/if}
    <div class="markdown">
      <Prose text={doc.text} {store} {threadId} />
    </div>
  {:else}
    <img
      class="shot"
      src={`data:${doc.mimeType};base64,${doc.data}`}
      alt={doc.alt ?? strings.chat.documentImage}
    />
  {/if}
</div>

<style>
  .document {
    max-width: 100%;
    min-width: 0;
  }

  .markdown {
    padding: 8px 10px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
  }

  .shot {
    display: block;
    max-width: 100%;
    height: auto;
    /* A one-pixel image would otherwise be invisible; the box is what reads. */
    min-height: 24px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
</style>
