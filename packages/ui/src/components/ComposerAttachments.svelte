<script lang="ts">
  import { ChevronUp, FileText, X } from '@lucide/svelte';
  import type { Attachment } from '@boite/contracts';
  import { bytes } from '../lib/format';
  import { decodedBytes } from '../lib/attachments';
  import { unresolvedAssetId } from '../lib/draft-attachments';
  import { fill, strings } from '../lib/strings';
  import { imageLabel } from '../lib/composer-images';
  import { Closing } from '../lib/closing.svelte';
  import { focusWithin, keepFocus } from '../lib/focus';
  import { AttachmentPreviews } from '../lib/attachment-previews.svelte';

  /** The attachments this prompt carries, above the box they were pasted into. */
  let { attachments, highlighted = null, onremove, onfocus }: {
    attachments: Attachment[];
    highlighted?: Attachment | null;
    onremove: (at: number) => void;
    onfocus: () => void;
  } = $props();
  let selected = $state<Attachment | null>(null);
  let previewElement = $state<HTMLElement>();
  let strip = $state<HTMLElement>();
  const preview = new Closing();
  const pictures = new AttachmentPreviews();
  // A copy reads every entry here, so a push into the prompt's list syncs too.
  $effect(() => { pictures.sync([...attachments]); });
  $effect(() => () => pictures.close());
  const images = $derived(attachments.filter(attachment => attachment.kind === 'image'));
  /** Tile widths, in px: the strip is one row and counts what fits from these. */
  const IMAGE_TILE = 56, FILE_TILE = 168, MORE_TILE = 44, GAP = 6;
  let row = $state<DOMRectReadOnly>();
  let expanded = $state(false);
  const widths = $derived(attachments.map(attachment => attachment.kind === 'image' && !unresolvedAssetId(attachment) ? IMAGE_TILE : FILE_TILE));
  const overflows = $derived(!!row?.width && widths.reduce((sum, width) => sum + width, 0) + GAP * (widths.length - 1) > row.width);
  /** How many tiles show before the "+N" one; every tile when the row has room, is open or is not laid out yet. */
  const shown = $derived.by(() => {
    if (!overflows || expanded || !row) return attachments.length;
    let used = MORE_TILE, count = 0;
    for (const width of widths) {
      if (used + GAP + width > row.width) break;
      used += GAP + width;
      count++;
    }
    return count;
  });
  const hidden = $derived(attachments.length - shown);
  const visible = $derived(selected?.kind === 'image' && attachments.includes(selected) && !unresolvedAssetId(selected) ? selected : null);

  /**
   * Back to the box when the focus is in the composer, where a keyboard put it.
   * A tap keeps the focus it had (`keepFocus`): focusing the box from there
   * would open a phone's keyboard the user had closed.
   */
  function refocus() {
    if (focusWithin(strip?.closest('[data-testid="composer"]'))) onfocus();
  }

  export function open(attachment: Attachment) {
    if (attachment.kind !== 'image' || unresolvedAssetId(attachment)) return;
    selected = attachment;
    preview.show();
    refocus();
  }

  /** The tile toggles: a tap on the picture already shown puts it away again. */
  function pick(attachment: Attachment) {
    if (visible === attachment && preview.open) closePreview();
    else open(attachment);
  }

  export function closePreview(): boolean {
    if (!visible || !preview.shown) return false;
    preview.hide();
    refocus();
    return true;
  }
</script>

<svelte:document onpointerdowncapture={(event) => {
  if (preview.open && event.target instanceof Node && !previewElement?.closest('[data-testid="composer"]')?.contains(event.target)) preview.hide();
}} onkeydowncapture={(event) => {
  // A tap opens the preview without moving the focus; with nothing focused,
  // Escape closes the preview before the app reads it as stopping the turn.
  if (event.target === document.body && event.key === 'Escape' && !event.isComposing && !event.defaultPrevented && closePreview()) {
    event.preventDefault(); event.stopPropagation();
  }
}} />

{#if visible && preview.shown}
  <section bind:this={previewElement} class="image-preview" class:closing={preview.closing} use:preview.attach onanimationend={preview.end}
    class:highlighted={highlighted === visible} data-testid="composer-image-preview"
    aria-label={fill(strings.composer.imagePreview, { image: imageLabel(images.indexOf(visible) + 1) })}>
    <header>
      <span>{imageLabel(images.indexOf(visible) + 1)}</span>
      <span class="preview-name">{visible.name ?? strings.composer.attachAlt}</span>
      <button type="button" class="ghost icon" data-testid="composer-image-close" title={strings.composer.imagePreviewClose} aria-label={strings.composer.imagePreviewClose} onmousedown={keepFocus} onclick={closePreview}><X size={16} /></button>
    </header>
    <!-- The enlarged picture closes on a click too, the way it opened. -->
    <button type="button" class="preview-image" data-testid="composer-image-shrink" title={strings.composer.imagePreviewClose} aria-label={strings.composer.imagePreviewClose} onmousedown={keepFocus} onclick={closePreview}>
      <img src={pictures.full(visible)} alt={visible.name ?? strings.composer.attachAlt} />
    </button>
  </section>
{/if}

<div bind:this={strip} class="attachments" class:expanded={expanded && overflows} bind:contentRect={row} data-testid="composer-attachments">
  {#each attachments.slice(0, shown) as attachment, at (attachment)}
    {@const label = attachment.name ?? strings.composer.attachAlt}
    {@const pending = unresolvedAssetId(attachment)}
    <div class="attachment" style:width="{widths[at]}px" class:highlighted={highlighted === attachment} class:selected={visible === attachment && preview.shown} class:document={attachment.kind === 'file' || !!pending} data-testid="composer-attachment" title={pending ? strings.errors.draftAttachment : attachment.kind === 'image' ? `${imageLabel(images.indexOf(attachment) + 1)} · ${label}` : label}>
      {#if attachment.kind === 'image' && !pending}
        {@const thumb = pictures.thumb(attachment)}
        <button type="button" class="image-open" data-testid="composer-image-open"
          aria-label={fill(strings.composer.imagePreview, { image: imageLabel(images.indexOf(attachment) + 1) })}
          aria-expanded={visible === attachment && preview.shown} onmousedown={keepFocus} onclick={() => pick(attachment)}>
          {#if thumb}<img src={thumb} alt={label} />{/if}
        </button>
      {:else}
        <FileText size={20} strokeWidth={1.5} />
        <span class="file-info"><span>{label}</span><small>{pending ? strings.composer.attachPending : bytes(decodedBytes(attachment.data))}</small></span>
      {/if}
      <button
        type="button"
        class="remove"
        data-testid="composer-attachment-remove"
        title={fill(strings.composer.attachRemove, { name: label })}
        aria-label={fill(strings.composer.attachRemove, { name: label })}
        onmousedown={keepFocus}
        onclick={() => onremove(at)}
      >
        <X size={12} strokeWidth={2.25} />
      </button>
    </div>
  {/each}
  {#if hidden > 0}
    <button type="button" class="more" class:highlighted={!!highlighted && attachments.indexOf(highlighted) >= shown} data-testid="composer-attachments-more"
      title={fill(strings.composer.attachMore, { count: String(hidden) })} aria-label={fill(strings.composer.attachMore, { count: String(hidden) })}
      onmousedown={keepFocus} onclick={() => expanded = true}>+{hidden}</button>
  {:else if expanded && overflows}
    <button type="button" class="more" data-testid="composer-attachments-less" title={strings.composer.attachLess} aria-label={strings.composer.attachLess}
      onmousedown={keepFocus} onclick={() => expanded = false}><ChevronUp size={16} /></button>
  {/if}
</div>

<style>
  /* One row of small tiles above the box; the last one counts what did not fit and opens the rest. */
  .attachments {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    padding: 8px 12px 0;
    overflow: hidden;
  }
  /* Opened, the tiles wrap and scroll past three and a half rows, the half row telling there is more: fifty would push the bar off a phone. */
  .attachments.expanded { flex-wrap: wrap; max-height: calc(8px + 3.5 * 42px + 3 * 6px); overflow-y: auto; overscroll-behavior: contain; }

  .attachment, .more {
    position: relative;
    flex: none;
    height: 42px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    overflow: hidden;
    animation: pop var(--dur-2) var(--ease-out-quint);
  }

  .more {
    width: 44px;
    padding: 0;
    box-shadow: none;
    color: var(--color-muted-foreground);
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
  }
  .more:hover:not(:disabled) { background: var(--color-surface-3); color: var(--color-foreground); }

  .image-open { display: flex; width: 100%; height: 100%; padding: 0; border: none; border-radius: inherit; background: transparent; box-shadow: none; }
  .attachment img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .attachment:hover, .attachment:focus-within, .attachment.highlighted, .attachment.selected, .more.highlighted { border-color: var(--color-accent); background: var(--color-accent-soft); }
  .attachment.highlighted, .more.highlighted { box-shadow: 0 0 0 2px var(--color-accent-soft); }

  .image-preview { margin: 10px 10px 0; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-background); animation: pop var(--dur-2) var(--ease-out-quint); }
  .image-preview.closing { animation-name: pop-out; }
  .image-preview.highlighted { border-color: var(--color-accent); }
  .image-preview header { display: flex; align-items: center; gap: 10px; padding: 2px 4px 2px 12px; font-size: var(--text-xs); }
  .preview-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-muted-foreground); }
  .preview-image { display: block; width: 100%; height: auto; padding: 0; border: none; border-radius: 0; background: transparent; box-shadow: none; cursor: zoom-out; }
  .preview-image:hover:not(:disabled) { background: transparent; }
  .preview-image img { display: block; width: 100%; height: min(40vh, 420px); object-fit: contain; }

  .attachment.document { display: flex; align-items: center; gap: 8px; padding: 0 24px 0 10px; color: var(--color-muted-foreground); }
  .file-info { min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: var(--text-xs); }
  .file-info > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--color-foreground); }
  .file-info small { font-size: var(--text-xs); }

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
    box-shadow: none;
    transition: opacity var(--dur-2) var(--ease-out-quint), transform var(--dur-2) var(--ease-out-quint), background var(--dur-1) var(--ease-out-quint);
  }

  /* A pointer sees the cross on the picture it is over, or the keyboard on its chip; the rest of the strip stays clean. A touch screen has no hover and keeps it. */
  @media (hover: hover) and (pointer: fine) {
    .attachment .remove { opacity: 0; transform: scale(0.85); }
    .attachment:hover .remove, .attachment:focus-within .remove { opacity: 1; transform: none; }
  }
  .attachment.document .remove { background: transparent; }
  .attachment .remove:hover:not(:disabled) { background: var(--color-danger); color: var(--color-on-danger); }

  @media (max-width: 720px) {
    .preview-image img { height: min(28dvh, 260px); }
  }
</style>
