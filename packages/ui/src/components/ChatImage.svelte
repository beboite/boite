<script lang="ts">
  import { imageSize, type Message } from '@boite/contracts';
  import { onView } from '../lib/on-view';
  import { fill, strings } from '../lib/strings';
  import { transferBytes } from '../lib/format';
  import type { Store } from '../lib/store.svelte';

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;
  /** The proportions a tile keeps, width over height: a long screenshot is cropped rather than drawn as a sliver. */
  const TILE_NARROWEST = 0.6, TILE_WIDEST = 1.8;

  /**
   * A prompt's picture as a thumbnail, in a box of its final size from the
   * first frame. A picture a light page left on the core comes with its size and its
   * blur: the box shows the blur, asks for the bytes once it nears the screen,
   * and the picture fades in over it. One that came with its bytes reads its
   * size from their header. Nothing around the box moves when the bytes land.
   */
  let {
    store,
    threadId,
    messageId,
    partIndex,
    image,
    tile
  }: {
    store: Store;
    threadId: string;
    messageId: string;
    partIndex: number;
    image: ImagePart;
    /** The thumbnail's height. Its width keeps the picture's proportions, held between narrow and wide, and the picture is cropped to fill it. */
    tile: number;
  } = $props();

  let shown = $state(false);
  let failed = $state(false);
  /** The light copy the core made for the timeline (`loadDisplayImage`). */
  let copy = $state<string | null>(null);

  /** The original, once the part holds it: sent inline, or fetched for the viewer or an edit. */
  const original = $derived(image.dataDeferred || image.data.length === 0 ? null : `data:${image.mimeType};base64,${image.data}`);
  const src = $derived(original ?? copy);
  const size = $derived(image.width && image.height ? { width: image.width, height: image.height } : image.data.length > 0 ? imageSize(image.data) : null);
  /** The box's width from the first frame: square until the picture's size is known. */
  const width = $derived(Math.round(size === null ? tile : Math.min(TILE_WIDEST, Math.max(TILE_NARROWEST, size.width / size.height)) * tile));

  // Near the screen a deferred picture asks for its light copy, once while a
  // request runs or after one succeeded; a failed one asks again the next
  // time it nears the screen. The original comes only when opened.
  let asked = false;
  function load(): void {
    if (asked || original !== null) return;
    asked = true;
    store.loadDisplayImage(threadId, messageId, partIndex, image.mimeType).then((url) => {
      copy = url;
      failed = false;
    }, (error: unknown) => {
      failed = true;
      asked = false;
      store.reportError(error, 'minor');
    });
  }
</script>

<span
  class="media"
  class:shown
  style:width="{width}px"
  style:height="{tile}px"
  title={failed ? strings.chat.imageUnavailable : undefined}
  data-testid="image-box"
  data-state={shown ? 'shown' : failed ? 'failed' : src ? 'loading' : 'waiting'}
  use:onView={load}
>
  {#if image.preview && !shown}
    <img class="blur" src={image.preview} alt="" aria-hidden="true" data-testid="image-preview" />
  {:else if !src && !shown}
    <span class="waiting" aria-hidden="true">{image.bytes ? fill(strings.chat.partLoading, { size: transferBytes(image.bytes) }) : ''}</span>
  {/if}
  {#if src}
    <img class="picture" data-testid="image-part" {src} alt={image.alt ?? ''} decoding="async" onload={() => (shown = true)} onerror={() => (failed = true)} />
  {/if}
</span>

<style>
  .media {
    position: relative;
    display: block;
    max-width: 100%;
    overflow: hidden;
    background: var(--color-surface-2);
  }

  .blur,
  .picture {
    position: absolute;
    top: 0;
    left: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .waiting {
    position: absolute;
    top: 50%;
    left: 0;
    width: 100%;
    transform: translateY(-50%);
    color: var(--color-muted-foreground);
    font-size: var(--text-xs);
    text-align: center;
  }

  .picture {
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .shown .picture {
    opacity: 1;
  }
</style>
