<script lang="ts">
  import { ArrowUp, Paperclip } from '@lucide/svelte';
  import type { Attachment, PreviewReference } from '@boite/contracts';
  import { strings } from '../lib/strings';

  /** The prompts waiting behind the running turn, each one a way back into the box. */
  let {
    queued,
    disabled,
    onrestore
  }: {
    queued: { text: string; attachments: Attachment[]; previewReferences?: PreviewReference[] }[];
    /** A prompt comes back only into an empty box, and never while one is going out. */
    disabled: boolean;
    onrestore: (at: number) => void;
  } = $props();
</script>

<div class="queued" data-testid="composer-queued">
  <span class="subtle">{strings.composer.queued}</span>
  {#each queued as entry, at (entry)}
    <button type="button" class="ghost queued-entry"
      title={strings.composer.editQueued}
      {disabled}
      onclick={() => onrestore(at)}>
      <span>{entry.text || strings.composer.attachAlt}</span>
      {#if entry.attachments.length}<span class="subtle">{entry.attachments.length} <Paperclip size={12} /></span>{/if}
      {#if entry.previewReferences?.length}<span class="subtle">@{entry.previewReferences.length}</span>{/if}
      <ArrowUp size={12} />
    </button>
  {/each}
</div>

<style>
  .queued {
    padding: 6px 14px 0;
    font-size: var(--text-sm);
  }

  .queued-entry { display: flex; gap: 8px; width: 100%; text-align: left; min-width: 0; }
  .queued-entry > span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .queued-entry > span { display: inline-flex; align-items: center; gap: 4px; }
</style>
