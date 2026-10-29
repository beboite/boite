<script lang="ts">
  import { AppWindow, Camera, Film, Radio } from '@lucide/svelte';
  import type { MessagePart } from '@boite/contracts';
  import { clockTime, fullTime } from '../lib/format';
  import { galleryFrom, media, viewerHost, type Gallery, type MediaItem } from '../lib/media-gallery';
  import { fill, strings } from '../lib/strings';
  import Deferred, { parts } from './Deferred.svelte';

  /**
   * A window an agent captured with `boite window`, or whose live view a viewer
   * started (docs/windows.md): no capture is silent. The thumbnail opens in the
   * image viewer with the timeline's other pictures.
   */
  let { part }: { part: Extract<MessagePart, { type: 'window_capture' }> } = $props();
  const s = strings.windows.capture;

  const host = viewerHost();
  let viewing = $state<Gallery | null>(null);
  const kindText = $derived(part.kind === 'clip' ? fill(s.clip, { count: String(part.frames ?? 0) }) : part.kind === 'stream' ? s.stream : s.screenshot);
  const src = $derived(part.thumbnail ? `data:image/jpeg;base64,${part.thumbnail.data}` : null);

  function item(): MediaItem | null {
    return src ? { src, name: fill(s.alt, { process: part.process }), mimeType: 'image/jpeg', kind: 'image' } : null;
  }
  function open(from: HTMLElement): void {
    const own = item();
    if (!own) return;
    const gallery = galleryFrom(from, own);
    if (host) host.open(gallery); else viewing = gallery;
  }
</script>

<div class="capture" data-testid="window-capture" data-kind={part.kind}>
  {#if src && part.thumbnail}
    <button type="button" class="thumb" use:media={item} aria-label={fill(s.open, { process: part.process })} title={fill(s.open, { process: part.process })} data-testid="window-capture-thumb" onclick={(event) => open(event.currentTarget)}>
      <img {src} width={part.thumbnail.width} height={part.thumbnail.height} alt={fill(s.alt, { process: part.process })} draggable="false" />
    </button>
  {:else}
    <span class="thumb empty" aria-hidden="true"><AppWindow size={20} strokeWidth={1.75} /></span>
  {/if}
  <div class="about">
    <span class="line">
      <span class="glyph">{#if part.kind === 'clip'}<Film size={15} strokeWidth={1.75} />{:else if part.kind === 'stream'}<Radio size={15} strokeWidth={1.75} />{:else}<Camera size={15} strokeWidth={1.75} />{/if}</span>
      <span class="process ui-label" data-testid="window-capture-process">{part.process}</span>
      <span class="kind ui-label" data-testid="window-capture-kind">{kindText}</span>
    </span>
    <span class="meta">
      <time datetime={new Date(part.at).toISOString()} title={fullTime(part.at)}>{clockTime(part.at)}</time>
      <span>{part.width}×{part.height}</span>
    </span>
    {#if part.path}<code class="path" title={part.path} data-testid="window-capture-path">{part.path}</code>{/if}
  </div>
</div>

{#if viewing}{@const view = viewing}<Deferred part={parts.ImageViewer} floating>{#snippet children(ImageViewer)}<ImageViewer items={view.items} index={view.index} onclose={() => viewing = null} />{/snippet}</Deferred>{/if}

<style>
  .capture {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
    padding: 8px 12px;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    box-shadow: var(--shadow-e1);
  }
  .thumb {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 112px;
    height: 72px;
    padding: 0;
    border: 1px solid var(--color-edge);
    border-radius: var(--radius-sm);
    background: var(--color-surface-2);
    overflow: hidden;
    cursor: zoom-in;
  }
  .thumb.empty { cursor: default; color: var(--color-subtle); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .about { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .line { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .glyph { display: inline-flex; flex: none; color: var(--color-accent); }
  .process { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kind { flex: none; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .meta { display: flex; gap: 10px; font-size: var(--text-xs); color: var(--color-subtle); }
  .path { font-size: var(--text-xs); color: var(--color-muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 720px) { .thumb { width: 88px; height: 56px; } }
</style>
