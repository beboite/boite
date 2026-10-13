<script lang="ts">
  import { secureId } from '../lib/secure-id';
  import { Check, Mic, X, LoaderCircle, RotateCcw, Settings2, Trash2 } from '@lucide/svelte';
  import { Closing } from '../lib/closing.svelte';
  import { floating } from '../lib/floating';
  import DictationSpectrum from './DictationSpectrum.svelte';
  import { onDestroy } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import { RpcErrorCode } from '@boite/contracts';
  import { RpcFailure, type Client } from '../lib/client';
  import { SpeechRecorder, audioBase64, microphoneError } from '../lib/speech-recorder';
  import { SpeechPreview } from '../lib/speech-preview';
  import { SpeechStream } from '../lib/speech-stream';
  import { strings } from '../lib/strings';
  import { voice } from '../lib/voice-prefs.svelte';
  let { store, ontext, onbusy, onpreview }: { store: Store; ontext: (text: string) => void; onbusy: (busy: boolean) => void; onpreview: (text: string, status: string, error: boolean) => void } = $props();
  let phase = $state<'idle' | 'opening' | 'recording' | 'transcribing' | 'error'>('idle');
  let seconds = $state(0);
  let error = $state('');
  let needsSetup = $state(false);
  let engine = $state<'local' | 'api'>('local');
  let recorder: SpeechRecorder | null = null;
  /** The live recorder's analyser while it records, for the spectrum. */
  let analyser = $state.raw<AnalyserNode | null>(null);
  let audio = $state.raw<Uint8Array | null>(null);
  let requestId: string | null = null;
  let generation = 0;
  let revision = '';
  let disposed = false;
  let client: Client | null = null;
  let preview: SpeechPreview | null = null;
  let stream: SpeechStream | null = null;
  let previewText = '';
  /** The language a preview heard, sent with the final request so the engine skips its detection. */
  let heard: string | undefined;
  let previewTimer: ReturnType<typeof setInterval> | null = null;
  function stopPreview() {
    if (previewTimer) clearInterval(previewTimer);
    previewTimer = null;
    const pending = preview?.stop(); preview = null;
    return pending;
  }
  function cancel() {
    generation++;
    void stopPreview();
    void stream?.stop(); stream = null;
    recorder?.dispose(); recorder = null; audio = null; analyser = null;
    if (requestId && client) void client.call('speech.cancel', { requestId }).catch(() => {});
    requestId = null; phase = 'idle'; onbusy(false); onpreview('', '', false);
  }
  onDestroy(() => { disposed = true; cancel(); });
  function fail(cause: unknown) { error = microphoneError(cause); phase = 'error'; analyser = null; onbusy(false); onpreview(previewText, error, true); }
  async function start() {
    client = store.client;
    if (!client) return;
    const run = ++generation;
    error = ''; needsSetup = false; audio = null; seconds = 0; analyser = null; previewText = ''; heard = undefined;
    phase = 'opening'; onbusy(true);
    onpreview('', strings.speech.opening, false);
    // Permission is requested inside the click, before an RPC can consume activation.
    const capture = new SpeechRecorder(); recorder = capture;
    try {
      let captureEnded = false;
      const captureStarted = capture.start((_value, elapsed) => { seconds = elapsed; }, () => { captureEnded = true; if (phase === 'recording') void stop(); }, voice.current.microphoneId);
      // A local engine starts loading its model while the user speaks. A core without it just answers later.
      void client.call('speech.warm', {}).catch(() => {});
      // A core from before dictation has no voice engine: name the machine to update instead of the raw RPC error.
      const statusPromise = client.call('speech.status', {}).catch((cause: unknown) => {
        if (cause instanceof RpcFailure && cause.code === RpcErrorCode.MethodNotFound) {
          throw new Error(strings.speech.unsupportedDictation.replace('{machine}', store.core?.hostname ?? strings.app.name));
        }
        throw cause;
      });
      const [status] = await Promise.all([statusPromise, captureStarted]);
      if (run !== generation || disposed) { capture.dispose(); return; }
      engine = status.engine; revision = status.revision;
      if (!status.ready) { needsSetup = true; throw new Error(store.owner ? strings.speech.setup : strings.speech.ownerSetup); }
      phase = 'recording'; analyser = capture.analyser ?? null;
      onpreview('', strings.speech.listening, false);
      const onLiveText = (text: string) => {
        if (run !== generation || disposed || phase !== 'recording') return;
        previewText = text; onpreview(text, strings.speech.live, false);
      };
      const onLiveError = (cause: unknown) => {
        if (run === generation && !disposed && phase === 'recording') onpreview(previewText, `${strings.speech.previewFailed} ${microphoneError(cause)}`, true);
      };
      if (status.streaming) {
        stream = new SpeechStream(client, revision, onLiveText, onLiveError);
        previewTimer = setInterval(() => stream?.update(() => capture.takeChunk()), 400);
      } else {
        preview = new SpeechPreview(client, revision, onLiveText, onLiveError);
        const interval = Math.max(1000, status.previewIntervalMs ?? 2500);
        previewTimer = setInterval(() => preview?.update(() => capture.snapshot(interval <= 1000 ? 4 : 12)), interval);
      }
      if (captureEnded) void stop();
    } catch (cause) { capture.dispose(); if (run === generation && !disposed) fail(cause); }
  }
  async function stop() {
    if (phase !== 'recording' || !recorder) return;
    const run = generation;
    phase = 'transcribing'; analyser = null;
    onpreview(previewText, strings.speech.transcribing, false);
    const lastPreview = preview;
    const drained = stopPreview();
    const liveStream = stream;
    try {
      const recording = await recorder.stop(); await drained;
      if (run !== generation || disposed) { await liveStream?.stop(); return; }
      audio = recording; heard = lastPreview?.language;
      if (liveStream) {
        const text = await liveStream.finish(recording);
        if (run !== generation || disposed) return;
        if (!text.trim()) throw new Error(strings.speech.silence);
        ontext(text); audio = null; phase = 'idle'; onbusy(false); onpreview('', '', false);
      } else await transcribe();
    }
    catch (cause) { await liveStream?.stop(); if (run === generation && !disposed) fail(cause); }
    finally { if (stream === liveStream) stream = null; }
  }
  async function transcribe() {
    if (!audio || !client) return;
    const run = generation;
    phase = 'transcribing'; onbusy(true);
    onpreview(previewText, strings.speech.transcribing, false);
    try {
      requestId = secureId();
      const result = await client.call('speech.transcribe', { requestId, revision, audio: audioBase64(audio), ...(heard ? { language: heard } : {}) });
      if (run !== generation || disposed) return;
      if (!result.text.trim()) throw new Error(strings.speech.silence);
      ontext(result.text); audio = null; phase = 'idle'; onbusy(false); onpreview('', '', false);
    } catch (cause) { if (run === generation && !disposed) fail(cause); }
    finally { if (run === generation) requestId = null; }
  }
  /** Something to throw away: a recording under way or kept for a retry. */
  const holding = $derived(phase === 'opening' || phase === 'recording' || phase === 'transcribing' || (phase === 'error' && !!audio));
  const busy = $derived(phase === 'opening' || phase === 'transcribing');
  const clock = $derived(`${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`);
  let microphone = $state<HTMLButtonElement>();
  /**
   * The recording's own menu floats at the composer's corner beside the
   * microphone: under the composer, or above it when the window has no room
   * below. Nothing in the composer moves while it runs, and the menu never
   * covers the draft or the live transcript.
   */
  const panel = new Closing();
  $effect(() => { if (phase === 'idle') panel.hide(); else panel.show(); });
  function keydown(event: KeyboardEvent) {
    if (phase !== 'idle' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
  }
</script>

<svelte:window onkeydowncapture={keydown} onpagehide={cancel} />
<svelte:document onvisibilitychange={() => { if (document.hidden && (phase === 'recording' || phase === 'opening')) cancel(); }} />

<div class="dictation" data-testid="dictation" data-phase={phase}>
  <button type="button" class="icon microphone" class:listening={phase === 'recording'} class:busy bind:this={microphone}
    data-testid={phase === 'recording' ? 'dictation-stop' : 'dictation-start'}
    title={phase === 'recording' ? `${strings.speech.stop} · ${engine === 'local' ? strings.speech.private : strings.speech.cloud}` : strings.speech.start}
    aria-label={phase === 'recording' ? strings.speech.stop : strings.speech.start} aria-pressed={phase === 'recording'}
    disabled={store.connection !== 'ready' || busy}
    onclick={() => { if (phase === 'recording') void stop(); else { cancel(); void start(); } }}>
    {#if phase === 'recording'}<Check size={16} strokeWidth={2.25} />
    {:else if busy}<LoaderCircle size={16} class="spinner" />
    {:else}<Mic size={16} strokeWidth={1.75} />{/if}
  </button>
  {#if phase === 'recording'}<span class="sr-only">{strings.speech.listening}</span>{/if}
  {#if panel.shown}
    <div class="panel" class:closing={panel.closing} class:failed={phase === 'error'} role="group" aria-label={strings.speech.heading} data-testid="dictation-panel"
      use:panel.attach use:floating={{ anchor: () => microphone?.closest<HTMLElement>('.composer') ?? microphone ?? null, placement: 'bottom', align: 'end', sheet: false }} onanimationend={panel.end}>
      {#if holding}
        <button type="button" class="icon ghost discard" data-testid="dictation-cancel" title={strings.speech.discard} aria-label={strings.speech.discard} onclick={cancel}><Trash2 size={15} strokeWidth={1.75} /></button>
      {:else}
        <button type="button" class="icon ghost discard" data-testid="dictation-cancel" title={strings.common.cancel} aria-label={strings.common.cancel} onclick={cancel}><X size={15} /></button>
      {/if}
      <span class="wave"><DictationSpectrum {analyser} mode={phase === 'recording' ? 'live' : phase === 'error' || phase === 'idle' ? 'still' : 'busy'} /></span>
      {#if holding}<span class="duration ui-label">{clock}</span>{/if}
      {#if phase === 'error' && audio}<button type="button" class="icon ghost" data-testid="dictation-retry" title={strings.speech.retry} aria-label={strings.speech.retry} onclick={() => void transcribe()}><RotateCcw size={15} /></button>{/if}
      {#if phase === 'error' && needsSetup && store.owner}<button type="button" class="icon ghost" title={strings.speech.heading} aria-label={strings.speech.heading} onclick={() => store.showSettings('voice')}><Settings2 size={15} /></button>{/if}
    </div>
  {/if}
</div>

<style>
  .dictation { display: flex; align-items: center; flex: none; }
  .dictation button { flex: none; width: var(--control); height: var(--control); }
  /* Same face and place as the attach button beside it; while it records it is the Finish button, tinted. */
  .microphone { transition: background var(--dur-2), color var(--dur-2), border-color var(--dur-2), box-shadow var(--dur-2); }
  .microphone.listening { color: var(--color-accent); background: var(--color-accent-soft); border-color: var(--color-accent); box-shadow: 0 0 0 3px var(--color-accent-soft); }
  .microphone.busy:disabled { opacity: 1; color: var(--color-accent); }
  .panel {
    z-index: 40; display: flex; align-items: center; gap: 4px;
    padding: 4px 10px 4px 4px;
    background: var(--color-surface-3); border: 1px solid var(--color-border); border-radius: var(--radius-full);
    box-shadow: var(--shadow-e2);
    animation: pop var(--dur-2) var(--ease-out-quint);
  }
  .panel.closing { animation-name: pop-out; pointer-events: none; }
  .panel.failed { border-color: color-mix(in oklch, var(--color-danger) 45%, var(--color-border)); }
  .panel button { flex: none; width: var(--control-sm); height: var(--control-sm); border-radius: var(--radius-full); color: var(--color-muted-foreground); }
  .panel .discard:hover { color: var(--color-danger); background: color-mix(in oklch, var(--color-danger) 14%, transparent); }
  .wave { display: block; width: 140px; height: 22px; margin: 0 4px; }
  .duration { min-width: 3.4ch; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--color-muted-foreground); text-align: right; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  :global(.dictation .spinner) { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 720px) {
    .dictation button { width: var(--touch-target); height: var(--touch-target); border-radius: 50%; }
    .microphone:not(.listening) { background: transparent; border-color: transparent; }
    .panel button { width: var(--touch-target); height: var(--touch-target); }
    .wave { width: 150px; height: 26px; }
  }
  @media (prefers-reduced-motion: reduce) { :global(.dictation .spinner) { animation: none; } }
</style>
