<script lang="ts">
  import { Mic, Square, X, LoaderCircle, RotateCcw, Settings2 } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import type { Client } from '../lib/client';
  import { SpeechRecorder, audioBase64, microphoneError } from '../lib/speech-recorder';
  import { strings } from '../lib/strings';
  let { store, ontext, onbusy }: { store: Store; ontext: (text: string) => void; onbusy: (busy: boolean) => void } = $props();
  let phase = $state<'idle' | 'opening' | 'recording' | 'transcribing' | 'error'>('idle');
  let seconds = $state(0);
  let level = $state(0);
  let error = $state('');
  let needsSetup = $state(false);
  let engine = $state<'local' | 'api'>('local');
  let recorder: SpeechRecorder | null = null;
  let audio = $state.raw<Uint8Array | null>(null);
  let requestId: string | null = null;
  let generation = 0;
  let revision = '';
  let disposed = false;
  let client: Client | null = null;
  const bars = [0.4, 0.75, 1, 0.65, 0.9, 0.5, 0.8];
  function cancel() {
    generation++;
    recorder?.dispose(); recorder = null; audio = null;
    if (requestId && client) void client.call('speech.cancel', { requestId }).catch(() => {});
    requestId = null; phase = 'idle'; onbusy(false);
  }
  onDestroy(() => { disposed = true; cancel(); });
  function fail(cause: unknown) { error = microphoneError(cause); phase = 'error'; onbusy(false); }
  async function start() {
    client = store.client;
    if (!client) return;
    const run = ++generation;
    error = ''; needsSetup = false; audio = null; seconds = 0; level = 0;
    phase = 'opening'; onbusy(true);
    // Permission is requested inside the click, before an RPC can consume activation.
    const capture = new SpeechRecorder(); recorder = capture;
    try {
      const captureStarted = capture.start((value, elapsed) => { level = value; seconds = elapsed; }, () => { if (phase === 'recording') void stop(); });
      const statusPromise = client.call('speech.status', {});
      const [status] = await Promise.all([statusPromise, captureStarted]);
      if (run !== generation || disposed) { capture.dispose(); return; }
      engine = status.engine; revision = status.revision;
      if (!status.ready) { needsSetup = true; throw new Error(store.owner ? strings.speech.setup : strings.speech.ownerSetup); }
      phase = 'recording';
    } catch (cause) { capture.dispose(); if (run === generation && !disposed) fail(cause); }
  }
  async function stop() {
    if (phase !== 'recording' || !recorder) return;
    const run = generation;
    phase = 'transcribing';
    try { const recording = await recorder.stop(); if (run === generation && !disposed) { audio = recording; await transcribe(); } }
    catch (cause) { if (run === generation && !disposed) fail(cause); }
  }
  async function transcribe() {
    if (!audio || !client) return;
    const run = generation;
    phase = 'transcribing'; onbusy(true);
    requestId = crypto.randomUUID();
    try {
      const result = await client.call('speech.transcribe', { requestId, revision, audio: audioBase64(audio) });
      if (run !== generation || disposed) return;
      if (!result.text.trim()) throw new Error(strings.speech.silence);
      ontext(result.text); audio = null; phase = 'idle'; onbusy(false);
    } catch (cause) { if (run === generation && !disposed) fail(cause); }
    finally { if (run === generation) requestId = null; }
  }
  function keydown(event: KeyboardEvent) {
    if (phase !== 'idle' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
  }
</script>

<svelte:window onkeydowncapture={keydown} onpagehide={cancel} />
<svelte:document onvisibilitychange={() => { if (document.hidden && (phase === 'recording' || phase === 'opening')) cancel(); }} />

{#if phase === 'idle'}
  <button type="button" class="icon ghost microphone" data-testid="dictation-start" title={strings.speech.start} aria-label={strings.speech.start} disabled={store.connection !== 'ready'} onclick={() => void start()}><Mic size={16} strokeWidth={1.75} /></button>
{:else}
  <div class="dictation" class:error={phase === 'error'} data-testid="dictation" data-phase={phase}>
    {#if phase === 'recording'}
      <div class="meter" aria-hidden="true">{#each bars as height, index (index)}<i style:height={`${4 + level * height * 22}px`}></i>{/each}</div>
      <div class="description"><span>{strings.speech.listening}</span><small>{engine === 'local' ? strings.speech.private : strings.speech.cloud}</small></div>
      <span class="duration">{Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')}</span>
      <button class="icon finish" data-testid="dictation-stop" aria-label={strings.speech.stop} title={strings.speech.stop} onclick={() => void stop()}><Square size={13} fill="currentColor" /></button>
    {:else if phase === 'error'}
      <span class="message" role="alert">{error}</span>
      {#if audio}<button class="icon ghost" data-testid="dictation-retry" title={strings.speech.retry} aria-label={strings.speech.retry} onclick={() => void transcribe()}><RotateCcw size={16} /></button>{/if}
      {#if needsSetup && store.owner}<button class="icon ghost" title={strings.speech.heading} aria-label={strings.speech.heading} onclick={() => store.showSettings('voice')}><Settings2 size={16} /></button>{/if}
    {:else}
      <LoaderCircle size={17} class="spinner" /><span class="message" role="status">{phase === 'opening' ? strings.speech.opening : strings.speech.transcribing}</span>
    {/if}
    <button class="icon ghost" data-testid="dictation-cancel" title={strings.common.cancel} aria-label={strings.common.cancel} onclick={cancel}><X size={16} /></button>
  </div>
{/if}

<style>
  .microphone { flex: none; color: var(--color-muted-foreground); }
  .dictation { position: absolute; bottom: calc(100% + 8px); left: 0; right: 0; display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 10px 12px; border: 1px solid var(--color-edge); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); animation: rise var(--dur-2) var(--ease-out-quint); }
  .description { display: flex; flex-direction: column; flex: 1; font-size: var(--text-sm); }
  small { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .message { flex: 1; font-size: var(--text-sm); overflow-wrap: anywhere; }
  .error .message { color: var(--color-danger); }
  .duration { font-size: var(--text-sm); font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); }
  .meter { display: flex; gap: 3px; align-items: center; height: 28px; width: 39px; }
  i { width: 3px; border-radius: var(--radius-sm); background: var(--color-accent); transition: height var(--dur-1); }
  .finish { color: var(--color-on-foreground); background: var(--color-foreground); }
  .dictation button { flex: none; }
  :global(.dictation .spinner) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 720px) { .dictation { gap: 8px; } .dictation button, .microphone { min-width: var(--touch-target); min-height: var(--touch-target); } }
  @media (prefers-reduced-motion: reduce) { :global(.dictation .spinner) { animation: none; } }
</style>
