<!--
  The music playing on this computer (Spotify first): its cover when the
  session has one, the title and the artist scrolling when they are too long,
  with previous, play or pause, and next.
-->
<script lang="ts">
  import { Pause, Play, SkipBack, SkipForward } from '@lucide/svelte';
  import { appName, type MediaAction, type MediaState } from '../../lib/companion/media';
  import { strings } from '../../lib/strings';
  import Marquee from './Marquee.svelte';

  let { media, oncontrol }: { media: MediaState; oncontrol: (action: MediaAction) => void } = $props();
</script>

<div class="pill" class:paused={!media.playing} class:covered={!!media.art} data-testid="companion-media">
  {#if media.art}
    <span class="art">
      <img src={media.art} alt="" />
      <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
    </span>
  {:else}
    <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
  {/if}
  <span class="text" title="{media.title} · {media.artist} ({appName(media.app)})">
    <Marquee text={media.title || appName(media.app)} strong />
    {#if media.artist}<span class="artist"><Marquee text={media.artist} /></span>{/if}
  </span>
  <span class="controls">
    <button class="ghost icon" aria-label={strings.companion.media.previous} onclick={() => oncontrol('previous')}><SkipBack size={14} /></button>
    <button class="ghost icon" aria-label={media.playing ? strings.companion.media.pause : strings.companion.media.play} onclick={() => oncontrol('toggle')}>
      {#if media.playing}<Pause size={14} />{:else}<Play size={14} />{/if}
    </button>
    <button class="ghost icon" aria-label={strings.companion.media.next} onclick={() => oncontrol('next')}><SkipForward size={14} /></button>
  </span>
</div>

<style>
  .pill {
    display: flex;
    align-items: center;
    gap: 8px;
    width: max-content;
    max-width: 300px;
    padding: 2px 2px 2px 12px;
    border: 1px solid var(--color-border);
    border-radius: var(--radius-full);
    background: var(--color-surface);
    box-shadow: var(--shadow-e2);
    font-size: var(--text-xs);
  }
  .covered {
    padding-left: 3px;
  }
  /* The cover, round like the pill's end, with the bars over its corner. */
  .art {
    position: relative;
    flex: none;
    width: 30px;
    height: 30px;
  }
  .art img {
    display: block;
    width: 100%;
    height: 100%;
    border-radius: var(--radius-full);
    object-fit: cover;
    transition: filter var(--dur-2) var(--ease-out-quint);
  }
  .paused .art img {
    filter: grayscale(1);
    opacity: 0.7;
  }
  .art .eq {
    position: absolute;
    right: -3px;
    bottom: -1px;
    padding: 2px;
    border-radius: var(--radius-sm);
    background: var(--color-surface);
  }
  .eq {
    flex: none;
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 10px;
  }
  .eq i {
    width: 2.5px;
    height: 100%;
    border-radius: 1px;
    background: var(--color-success);
    transform-origin: bottom;
    animation: eq 0.9s ease-in-out infinite alternate;
  }
  .eq i:nth-child(2) {
    animation-delay: -0.3s;
  }
  .eq i:nth-child(3) {
    animation-delay: -0.6s;
  }
  .paused .eq i {
    animation: none;
    transform: scaleY(0.3);
    background: var(--color-muted-foreground);
  }
  .text {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
    max-width: 180px;
    line-height: 1.25;
  }
  .artist {
    min-width: 0;
    color: var(--color-muted-foreground);
  }
  .controls {
    flex: none;
    display: flex;
  }
  .controls button {
    width: 26px;
    height: 26px;
    border-radius: var(--radius-full);
    color: var(--color-foreground);
  }
  @keyframes eq {
    from {
      transform: scaleY(0.25);
    }
    to {
      transform: scaleY(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .eq i {
      animation: none;
      transform: scaleY(0.6);
    }
  }
</style>
