<script lang="ts">
  import { FileText, X } from '@lucide/svelte';
  import type { Attachment } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { fill, strings } from '../lib/strings';

  /** The attachments this prompt carries, above the box they were pasted into. */
  let { attachments, onremove }: { attachments: Attachment[]; onremove: (at: number) => void } = $props();
</script>

<div class="attachments" data-testid="composer-attachments">
  {#each attachments as attachment, at (at)}
    {@const label = attachment.name ?? strings.composer.attachAlt}
    <div class="attachment" class:document={attachment.kind === 'file'} data-testid="composer-attachment" title={label}>
      {#if attachment.kind === 'image'}
        <img src="data:{attachment.mimeType};base64,{attachment.data}" alt={label} />
      {:else}
        <FileText size={20} strokeWidth={1.5} />
        <span class="file-info"><span>{label}</span><small>{bytes(decodedBytes(attachment.data))}</small></span>
      {/if}
      <button
        type="button"
        class="icon small remove"
        data-testid="composer-attachment-remove"
        title={fill(strings.composer.attachRemove, { name: label })}
        aria-label={fill(strings.composer.attachRemove, { name: label })}
        onclick={() => onremove(at)}
      >
        <X size={12} strokeWidth={2.25} />
      </button>
    </div>
  {/each}
</div>

<style>
  /* The attachments this prompt carries, above the box they were pasted into. */
  .attachments {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 10px 14px 0;
  }

  .attachment {
    position: relative;
    width: 56px;
    height: 56px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .attachment.document { width: min(240px, 100%); display: flex; align-items: center; gap: 10px; padding: 0 48px 0 12px; }
  .file-info { min-width: 0; display: flex; flex-direction: column; gap: 3px; font-size: var(--text-sm); }
  .file-info > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-info small { color: var(--color-muted-foreground); font-size: var(--text-xs); }
  .attachment.document .remove { width: 44px; height: 44px; top: 5px; right: 0; background: transparent; }
  .attachment img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  /* The remove button rides the corner, readable over any picture. */
  .attachment .remove {
    position: absolute;
    top: 2px;
    right: 2px;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--color-scrim);
    color: var(--color-foreground);
  }

  .attachment .remove:hover:not(:disabled) {
    background: var(--color-danger);
    color: var(--color-on-danger);
  }
</style>
