<script lang="ts">
  import type { MediaRef } from '@boite/contracts';
  import type { MediaLease } from '../lib/media';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  /**
   * A picture of the timeline. Its box has the picture's size from the first
   * frame, read by the core from the header, and shows the core's blur until
   * the bytes land, so nothing around it moves when they do. The bytes are
   * asked for once the box nears the scrolled list, not when the message
   * arrives. A part that still carries its bytes (an older core) draws them
   * at once.
   */
  let {
    store,
    threadId,
    messageId,
    mimeType,
    data,
    media,
    alt,
    maxHeight = null,
    testid
  }: {
    store: Store;
    threadId: string;
    messageId: string;
    mimeType: string;
    data: string;
    media?: MediaRef;
    alt: string;
    /** The tallest the box is drawn; null draws the picture at its own size, the column permitting. */
    maxHeight?: number | null;
    testid?: string;
  } = $props();

  /** How far from the visible list a picture starts loading, so a scroll finds it there. */
  const AHEAD = '1000px 0px';

  let box = $state<HTMLElement | undefined>();
  let near = $state(false);
  let fetched = $state<string | null>(null);
  let shown = $state(false);
  let failed = $state(false);

  const inline = $derived(data.length > 0 ? `data:${mimeType};base64,${data}` : null);
  const src = $derived(inline ?? fetched);
  const sized = $derived(media?.width != null && media.height != null && media.width > 0 && media.height > 0 ? { width: media.width, height: media.height } : null);
  /** The box's width: the picture's own, shrunk to `maxHeight` keeping its proportions. The column still caps it. */
  const width = $derived(sized === null ? null : maxHeight === null ? sized.width : Math.min(sized.width, (maxHeight * sized.width) / sized.height));

  $effect(() => {
    const node = box;
    if (!node || inline !== null || near) return;
    if (typeof IntersectionObserver === 'undefined') { near = true; return; }
    // The list scrolls inside its own box: a margin on the page's viewport would
    // be clipped by it, so the list is the root when there is one.
    const root = node.closest<HTMLElement>('[data-media-root]');
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) near = true;
    }, { root, rootMargin: AHEAD });
    observer.observe(node);
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!near || inline !== null || !media) return;
    let lease: MediaLease | null = store.media.acquire({ threadId, messageId, slot: media.slot }, mimeType);
    lease.url.then((url) => { if (lease) fetched = url; }, () => { if (lease) failed = true; });
    return () => {
      lease?.release();
      lease = null;
    };
  });

  // A new address (a reconnect handing the bytes inline) starts the fade again.
  $effect(() => {
    void src;
    shown = false;
  });
</script>

<span
  bind:this={box}
  class="media"
  class:sized={sized !== null}
  class:shown
  class:failed
  style:width={width === null ? undefined : `${width}px`}
  style:aspect-ratio={sized === null ? undefined : `${sized.width} / ${sized.height}`}
  style:--media-max-height={maxHeight === null ? undefined : `${maxHeight}px`}
  title={failed ? strings.chat.imageUnavailable : undefined}
  data-testid={testid}
  data-state={shown ? 'shown' : failed ? 'failed' : src ? 'loading' : 'waiting'}
>
  {#if media?.preview && !shown}
    <img class="blur" src={media.preview} alt="" aria-hidden="true" data-testid="media-preview" />
  {/if}
  {#if src}
    <img class="picture" {src} {alt} decoding="async" onload={() => (shown = true)} onerror={() => (failed = true)} />
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

  /* Without a size from the core, the picture lays itself out as it always did. */
  .media:not(.sized) {
    min-height: 24px;
    background: none;
  }

  .media:not(.sized) .picture {
    position: static;
    display: block;
    width: auto;
    height: auto;
    max-width: 100%;
    max-height: var(--media-max-height, none);
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

  .picture {
    opacity: 0;
    transition: opacity var(--dur-2) var(--ease-out-quint);
  }

  .shown .picture {
    opacity: 1;
  }

  .failed .picture {
    display: none;
  }
</style>
