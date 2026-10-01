<script lang="ts">
  import { onMount } from 'svelte';
  import { X } from '@lucide/svelte';
  import { strings } from '../lib/strings';
  import { mobileOverlay } from '../lib/mobile-history';
  import { cameraFailure, openCamera, scanVideo, type ScanFailure } from '../lib/qr-scan';

  /**
   * The camera, full screen, until a code `accept` takes is in front of it.
   * The stream is opened here and stopped here: closing the view by its button,
   * by Back or by a result turns the camera light off.
   */
  let { accept, onresult, onclose }: { accept: (text: string) => boolean; onresult: (text: string) => void; onclose: () => void } = $props();
  let video = $state<HTMLVideoElement>();
  let failure = $state<ScanFailure | null>(null);
  let live = $state(false);

  onMount(() => {
    const stop = new AbortController();
    let stream: MediaStream | undefined;
    const release = mobileOverlay(onclose);
    void (async () => {
      try {
        stream = await openCamera();
        if (stop.signal.aborted || !video) { for (const track of stream.getTracks()) track.stop(); return; }
        video.srcObject = stream;
        await video.play();
        live = true;
        onresult(await scanVideo(video, stop.signal, accept));
      } catch (error) {
        if (!stop.signal.aborted) failure = cameraFailure(error);
      }
    })();
    return () => {
      stop.abort();
      for (const track of stream?.getTracks() ?? []) track.stop();
      release();
    };
  });

  function onkeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); onclose();
  }
</script>

<svelte:window onkeydowncapture={onkeydown} />
<div class="scanner" role="dialog" aria-modal="true" aria-labelledby="qr-scanner-title" data-testid="qr-scanner">
  <header>
    <h2 id="qr-scanner-title">{strings.machines.scanTitle}</h2>
    <button class="ghost icon" data-testid="qr-scanner-close" aria-label={strings.machines.scanClose} onclick={onclose}><X size={20} /></button>
  </header>
  <div class="view">
    <!-- Muted and inline: an iPhone otherwise opens the stream in its own full-screen player. -->
    <video bind:this={video} class:live muted playsinline aria-hidden="true"></video>
    {#if failure}
      <p class="status" role="alert" data-testid="qr-scanner-error">{strings.machines.scanErrors[failure]}</p>
    {:else}
      <div class="frame" aria-hidden="true"></div>
      {#if !live}<p class="status" role="status">{strings.machines.scanStarting}</p>{/if}
    {/if}
  </div>
  <p class="hint">{strings.machines.scanHint}</p>
</div>

<style>
  .scanner { position: fixed; inset: 0; z-index: 60; display: flex; flex-direction: column; background: var(--color-background); padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); animation: fade var(--dur-2) var(--ease-out-quint); }
  header { flex: none; display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 16px; }
  h2 { flex: 1; min-width: 0; margin: 0; font-size: var(--text-md); }
  header .icon { width: var(--touch-target); min-height: var(--touch-target); }
  .view { position: relative; flex: 1; min-height: 0; margin: 0 16px; overflow: hidden; border: 1px solid var(--color-border); border-radius: var(--radius-xl); background: var(--color-surface-2); display: grid; place-items: center; }
  video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity var(--dur-2); }
  video.live { opacity: 1; }
  /* Where to hold the code: a square the width of the view, never taller than it. */
  .frame { position: relative; width: min(70%, 280px); aspect-ratio: 1; border: 2px solid var(--color-accent); border-radius: var(--radius-lg); box-shadow: 0 0 0 100vmax var(--color-scrim); }
  .status { position: absolute; left: 16px; right: 16px; margin: 0; text-align: center; font-size: var(--text-base); line-height: 1.5; color: var(--color-foreground); overflow-wrap: anywhere; }
  .status[role=status] { color: var(--color-muted-foreground); }
  .hint { flex: none; margin: 0; padding: 14px 20px 18px; text-align: center; font-size: var(--text-sm); line-height: 1.5; color: var(--color-muted-foreground); }
  @media (prefers-reduced-motion: reduce) { .scanner { animation: none; } video { transition: none; } }
</style>
