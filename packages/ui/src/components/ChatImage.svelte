<script lang="ts">
  import { imageSize, type Message } from '@boite/contracts';
  import { onView } from '../lib/on-view';
  import { fill, strings } from '../lib/strings';
  import { transferBytes } from '../lib/format';
  import type { Store } from '../lib/store.svelte';

  type ImagePart = Extract<Message['parts'][number], { type: 'image' }>;

  /**
   * A picture of the timeline in a box of its own proportions from the first
   * frame. A picture a light page left on the core comes with its size and its
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
    maxHeight = null
  }: {
    store: Store;
    threadId: string;
    messageId: string;
    partIndex: number;
    image: ImagePart;
    /** The tallest the box is drawn; null draws the picture at its own size, the column permitting. */
    maxHeight?: number | null;
  } = $props();

  let shown = $state(false);
  let failed = $state(false);

  const src = $derived(image.dataDeferred || image.data.length === 0 ? null : `data:${image.mimeType};base64,${image.data}`);
  const size = $derived(image.width && image.height ? { width: image.width, height: image.height } : image.data.length > 0 ? imageSize(image.data) : null);
  /** The box's width: the picture's own, shrunk to `maxHeight` keeping its proportions. The column still caps it. */
  const width = $derived(size === null ? null : maxHeight === null ? size.width : Math.min(size.width, (maxHeight * size.width) / size.height));

  // A picture asks for its bytes once while a request runs or after one
  // succeeded; a failed one asks again the next time it nears the screen.
  let asked = false;
  function load(): void {
    if (asked || !image.dataDeferred) return;
    asked = true;
    store.loadMessageAttachment(threadId, messageId, partIndex).then(() => {
      failed = false;
    }, (error: unknown) => {
      failed = true;
      asked = false;
      store.reportError(error, 'minor');
    });
  }

  // New bytes (the deferred ones landing) fade in again.
  $effect(() => {
    void src;
    shown = false;
  });
</script>

<span
  class="media"
  class:sized={size !== null}
  class:shown
  style:width={width === null ? undefined : `${width}px`}
  style:aspect-ratio={size === null ? undefined : `${size.width} / ${size.height}`}
  style:--media-max-height={maxHeight === null ? undefined : `${maxHeight}px`}
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

  /* Without a size, the picture lays itself out as it always did. */
  .media:not(.sized) {
    min-width: 120px;
    min-height: 80px;
  }

  .media:not(.sized) .picture {
    position: static;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: var(--media-max-height, none);
  }

  .media:not(.sized).shown {
    min-width: 0;
    min-height: 0;
    background: none;
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
