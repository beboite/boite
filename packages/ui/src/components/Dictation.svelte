<script lang="ts">
  import { Check, Mic, X, LoaderCircle, RotateCcw, Settings2 } from '@lucide/svelte';
  import { onDestroy } from 'svelte';
  import type { Store } from '../lib/store.svelte';
  import type { Client } from '../lib/client';
  import { SpeechRecorder, audioBase64, microphoneError } from '../lib/speech-recorder';
  import { SpeechPreview } from '../lib/speech-preview';
  import { strings } from '../lib/strings';
  let { store, ontext, onbusy, onpreview }: { store: Store; ontext: (text: string) => void; onbusy: (busy: boolean) => void; onpreview: (text: string, status: string, error: boolean) => void } = $props();
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
  let preview: SpeechPreview | null = null;
  let previewText = '';
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
    recorder?.dispose(); recorder = null; audio = null;
    if (requestId && client) void client.call('speech.cancel', { requestId }).catch(() => {});
    requestId = null; phase = 'idle'; onbusy(false); onpreview('', '', false);
  }
  onDestroy(() => { disposed = true; cancel(); });
  function fail(cause: unknown) { error = microphoneError(cause); phase = 'error'; onbusy(false); onpreview(previewText, error, true); }
  async function start() {
    client = store.client;
    if (!client) return;
    const run = ++generation;
    error = ''; needsSetup = false; audio = null; seconds = 0; level = 0; previewText = '';
    phase = 'opening'; onbusy(true);
    onpreview('', strings.speech.opening, false);
    // Permission is requested inside the click, before an RPC can consume activation.
    const capture = new SpeechRecorder(); recorder = capture;
    try {
      let captureEnded = false;
      const captureStarted = capture.start((value, elapsed) => { level = value; seconds = elapsed; }, () => { captureEnded = true; if (phase === 'recording') void stop(); });
      const statusPromise = client.call('speech.status', {});
      const [status] = await Promise.all([statusPromise, captureStarted]);
      if (run !== generation || disposed) { capture.dispose(); return; }
      engine = status.engine; revision = status.revision;
      if (!status.ready) { needsSetup = true; throw new Error(store.owner ? strings.speech.setup : strings.speech.ownerSetup); }
      phase = 'recording';
      onpreview('', strings.speech.listening, false);
      preview = new SpeechPreview(client, revision, text => {
        if (run !== generation || disposed || phase !== 'recording') return;
        previewText = text; onpreview(text, strings.speech.live, false);
      }, cause => {
        if (run === generation && !disposed && phase === 'recording') onpreview(previewText, `${strings.speech.previewFailed} ${microphoneError(cause)}`, true);
      });
      previewTimer = setInterval(() => preview?.update(() => capture.snapshot()), 2500);
      if (captureEnded) void stop();
    } catch (cause) { capture.dispose(); if (run === generation && !disposed) fail(cause); }
  }
  async function stop() {
    if (phase !== 'recording' || !recorder) return;
    const run = generation;
    phase = 'transcribing';
    onpreview(previewText, strings.speech.transcribing, false);
    const drained = stopPreview();
    try { const recording = await recorder.stop(); await drained; if (run === generation && !disposed) { audio = recording; await transcribe(); } }
    catch (cause) { if (run === generation && !disposed) fail(cause); }
  }
  async function transcribe() {
    if (!audio || !client) return;
    const run = generation;
    phase = 'transcribing'; onbusy(true);
    onpreview(previewText, strings.speech.transcribing, false);
    requestId = crypto.randomUUID();
    try {
      const result = await client.call('speech.transcribe', { requestId, revision, audio: audioBase64(audio) });
      if (run !== generation || disposed) return;
      if (!result.text.trim()) throw new Error(strings.speech.silence);
      ontext(result.text); audio = null; phase = 'idle'; onbusy(false); onpreview('', '', false);
    } catch (cause) { if (run === generation && !disposed) fail(cause); }
    finally { if (run === generation) requestId = null; }
  }
  function keydown(event: KeyboardEvent) {
    if (phase !== 'idle' && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); }
  }
</script>

<svelte:window onkeydowncapture={keydown} onpagehide={cancel} />
<svelte:document onvisibilitychange={() => { if (document.hidden && (phase === 'recording' || phase === 'opening')) cancel(); }} />

<div class="dictation" data-testid="dictation" data-phase={phase}>
  <button type="button" class="icon microphone" class:listening={phase === 'recording'}
    data-testid={phase === 'recording' ? 'dictation-stop' : 'dictation-start'}
    title={phase === 'recording' ? `${strings.speech.stop} · ${engine === 'local' ? strings.speech.private : strings.speech.cloud}` : strings.speech.start}
    aria-label={phase === 'recording' ? strings.speech.stop : strings.speech.start} aria-pressed={phase === 'recording'}
    disabled={store.connection !== 'ready' || phase === 'opening' || phase === 'transcribing'}
    onclick={() => { if (phase === 'recording') void stop(); else { cancel(); void start(); } }}>
    {#if phase === 'recording'}<Check size={18} strokeWidth={2} />{:else}<Mic size={18} strokeWidth={1.75} />{/if}
    {#if phase === 'recording'}<i class="level" style:opacity={0.4 + level * 0.6}></i>{/if}
    {#if phase === 'opening' || phase === 'transcribing'}<LoaderCircle size={10} class="spinner" />{/if}
  </button>
  {#if phase === 'recording'}<span class="sr-only">{strings.speech.listening}<span class="duration">{Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, '0')}</span></span>{/if}
  {#if phase === 'error' && audio}<button class="icon ghost" data-testid="dictation-retry" title={strings.speech.retry} aria-label={strings.speech.retry} onclick={() => void transcribe()}><RotateCcw size={15} /></button>{/if}
  {#if phase === 'error' && needsSetup && store.owner}<button class="icon ghost" title={strings.speech.heading} aria-label={strings.speech.heading} onclick={() => store.showSettings('voice')}><Settings2 size={15} /></button>{/if}
  {#if phase !== 'idle'}<button class="icon ghost cancel" data-testid="dictation-cancel" title={strings.common.cancel} aria-label={strings.common.cancel} onclick={cancel}><X size={14} /></button>{/if}
</div>

<style>
  .dictation { display: flex; align-items: center; gap: 2px; flex: none; }
  .microphone { position: relative; color: var(--color-foreground); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-md); }
  .microphone.listening { color: var(--color-accent); background: var(--color-accent-soft); border-color: var(--color-accent); }
  .level { position: absolute; bottom: 3px; width: 3px; height: 3px; border-radius: var(--radius-sm); background: currentColor; }
  .dictation button { flex: none; width: var(--control); height: var(--control); }
  .cancel { color: var(--color-muted-foreground); }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  :global(.dictation .spinner) { position: absolute; bottom: 1px; right: 1px; animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 720px) {
    .dictation button { width: var(--touch-target); height: var(--touch-target); border-radius: 50%; }
    .microphone { background: transparent; border-color: transparent; }
    .microphone.listening { background: var(--color-accent-soft); border-color: transparent; }
    .cancel { order: -1; }
    .level { bottom: 6px; }
  }
  @media (prefers-reduced-motion: reduce) { :global(.dictation .spinner) { animation: none; } }
</style>
