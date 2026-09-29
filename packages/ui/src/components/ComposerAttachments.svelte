<script lang="ts">
  import { FileText, X } from '@lucide/svelte';
  import type { Attachment } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { unresolvedAssetId } from '../lib/draft-attachments';
  import { fill, strings } from '../lib/strings';
  import { imageLabel } from '../lib/composer-images';
  import { Closing } from '../lib/closing.svelte';

  /** The attachments this prompt carries, above the box they were pasted into. */
  let { attachments, highlighted = null, onremove, onfocus }: {
    attachments: Attachment[];
    highlighted?: Attachment | null;
    onremove: (at: number) => void;
    onfocus: () => void;
  } = $props();
  let selected = $state<Attachment | null>(null);
  let previewElement = $state<HTMLElement>();
  const preview = new Closing();
  const images = $derived(attachments.filter(attachment => attachment.kind === 'image'));
  const visible = $derived(selected?.kind === 'image' && attachments.includes(selected) && !unresolvedAssetId(selected) ? selected : null);

  export function open(attachment: Attachment) {
    if (attachment.kind !== 'image' || unresolvedAssetId(attachment)) return;
    selected = attachment;
    preview.show();
    onfocus();
  }

  export function closePreview(): boolean {
    if (!visible || !preview.shown) return false;
    preview.hide();
    onfocus();
    return true;
  }
</script>

<svelte:document onpointerdowncapture={(event) => {
  if (preview.open && event.target instanceof Node && !previewElement?.closest('[data-testid="composer"]')?.contains(event.target)) preview.hide();
}} />

{#if visible && preview.shown}
  <section bind:this={previewElement} class="image-preview" class:closing={preview.closing} use:preview.attach onanimationend={preview.end}
    class:highlighted={highlighted === visible} data-testid="composer-image-preview"
    aria-label={fill(strings.composer.imagePreview, { image: imageLabel(images.indexOf(visible) + 1) })}>
    <header>
      <span>{imageLabel(images.indexOf(visible) + 1)}</span>
      <span class="preview-name">{visible.name ?? strings.composer.attachAlt}</span>
      <button type="button" class="ghost icon" data-testid="composer-image-close" title={strings.composer.imagePreviewClose} aria-label={strings.composer.imagePreviewClose} onclick={closePreview}><X size={16} /></button>
    </header>
    <img src="data:{visible.mimeType};base64,{visible.data}" alt={visible.name ?? strings.composer.attachAlt} />
  </section>
{/if}

<div class="attachments" data-testid="composer-attachments">
  {#each attachments as attachment, at (attachment)}
    {@const label = attachment.name ?? strings.composer.attachAlt}
    {@const pending = unresolvedAssetId(attachment)}
    <div class="attachment" class:highlighted={highlighted === attachment} class:selected={visible === attachment && preview.shown} class:document={attachment.kind === 'file' || !!pending} data-testid="composer-attachment" title={pending ? strings.errors.draftAttachment : label}>
      {#if attachment.kind === 'image' && !pending}
        <button type="button" class="image-open" data-testid="composer-image-open"
          aria-label={fill(strings.composer.imagePreview, { image: imageLabel(images.indexOf(attachment) + 1) })}
          aria-expanded={visible === attachment && preview.shown} onclick={() => open(attachment)}>
          <img src="data:{attachment.mimeType};base64,{attachment.data}" alt={label} />
          <span>{imageLabel(images.indexOf(attachment) + 1)}</span>
        </button>
      {:else}
        <FileText size={20} strokeWidth={1.5} />
        <span class="file-info"><span>{label}</span><small>{pending ? strings.composer.attachPending : bytes(decodedBytes(attachment.data))}</small></span>
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
    width: 88px;
    height: 80px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .image-open { display: flex; flex-direction: column; gap: 0; width: 100%; height: 100%; padding: 0; border: none; border-radius: inherit; background: transparent; }
  .image-open span { font-size: var(--text-xs); padding: 3px; }
  .attachment .image-open img { height: 54px; object-fit: cover; }
  .attachment:hover, .attachment:focus-within, .attachment.highlighted, .attachment.selected { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .attachment.highlighted { box-shadow: 0 0 0 2px var(--color-accent-soft); }
  .image-preview { margin: 10px 10px 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-background); animation: pop var(--dur-2) var(--ease-out-quint); }
  .image-preview.closing { animation-name: pop-out; }
  .image-preview.highlighted { border-color: var(--color-accent); }
  .image-preview header { display: flex; align-items: center; gap: 10px; padding: 2px 4px 2px 12px; font-size: var(--text-xs); }
  .preview-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  .image-preview > img { display: block; width: 100%; height: min(40vh, 420px); object-fit: contain; }

  .attachment.document { width: min(240px, 100%); height: 56px; display: flex; align-items: center; gap: 10px; padding: 0 48px 0 12px; }
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
  @media (max-width: 720px) {
    .image-preview > img { height: min(28dvh, 260px); }
    .attachment .remove { width: 28px; height: 28px; }
  }
</style>
