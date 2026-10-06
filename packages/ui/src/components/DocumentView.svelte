<script lang="ts">
  import type { ToolDocument } from '@boite/contracts';
  import { mediaSource } from '../lib/media-source';
  import { strings } from '../lib/strings';
  import ChatImage from './ChatImage.svelte';
  import DiffView from './DiffView.svelte';
  import Prose from './Prose.svelte';

  /** One document a tool call produced, under the card's input and output. */
  let { doc }: { doc: ToolDocument } = $props();
  const source = mediaSource();
</script>

<div class="document" data-testid="tool-document" data-kind={doc.kind}>
  {#if doc.kind === 'diff'}
    <DiffView path={doc.path} oldText={doc.oldText} newText={doc.newText} />
  {:else if doc.kind === 'markdown'}
    {#if doc.title !== null}
      <div class="section-label">{doc.title}</div>
    {/if}
    <div class="markdown">
      <Prose text={doc.text} />
    </div>
  {:else if source}
    <span class="shot">
      <ChatImage
        store={source.store}
        threadId={source.threadId}
        messageId={source.messageId}
        mimeType={doc.mimeType}
        data={doc.data}
        media={doc.media}
        alt={doc.alt ?? strings.chat.documentImage}
      />
    </span>
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
    width: fit-content;
    max-width: 100%;
    height: auto;
    /* A one-pixel image would otherwise be invisible; the box is what reads. */
    min-height: 24px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    overflow: hidden;
  }
</style>
