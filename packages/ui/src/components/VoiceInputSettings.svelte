<script lang="ts">
  import { ChevronDown, Mic } from '@lucide/svelte';
  import { onMount, onDestroy } from 'svelte';
  import { MicrophoneMonitor } from '../lib/microphone';
  import { microphoneError } from '../lib/speech-recorder';
  import { voice, VOICE_STORAGE_KEY } from '../lib/voice-prefs.svelte';
  import { fill, strings } from '../lib/strings';
  import Menu from './Menu.svelte';

  let devices = $state<MediaDeviceInfo[]>([]);
  let phase = $state<'idle' | 'opening' | 'listening'>('idle');
  let level = $state(0), error = $state('');
  let monitor: MicrophoneMonitor | null = null;
  let generation = 0, deviceRead = 0, disposed = false;

  const inputs = $derived([
    { id: '', label: strings.speech.defaultMicrophone, active: !voice.current.microphoneId },
    ...devices.map((device, index) => ({ id: device.deviceId, label: device.label || fill(strings.speech.microphoneNumber, { number: String(index + 1) }), active: voice.current.microphoneId === device.deviceId })),
  ]);
  const selected = $derived(inputs.find(input => input.id === voice.current.microphoneId)?.label ?? strings.speech.microphoneUnavailable);

  async function refresh() {
    const read = ++deviceRead;
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const next = await navigator.mediaDevices.enumerateDevices();
      if (!disposed && read === deviceRead) devices = next.filter(device => device.kind === 'audioinput' && device.deviceId);
    } catch (cause) { if (!disposed && read === deviceRead) error = microphoneError(cause); }
  }

  function stop() {
    generation++;
    monitor?.dispose(); monitor = null;
    phase = 'idle'; level = 0;
  }

  async function start() {
    stop(); error = '';
    const run = generation;
    const capture = new MicrophoneMonitor(); monitor = capture;
    phase = 'opening';
    try {
      await capture.start(voice.current.microphoneId, value => { if (run === generation) level = value; }, () => {
        if (run !== generation) return;
        stop(); error = strings.speech.microphoneDisconnected;
        void refresh();
      });
      if (disposed || run !== generation) return;
      phase = 'listening';
      // Permission makes device names available on browsers that initially hide them.
      void refresh();
    } catch (cause) {
      if (!disposed && run === generation) { stop(); error = microphoneError(cause); }
    }
  }

  function pick(id: string) {
    const testing = phase !== 'idle';
    stop(); error = '';
    voice.setMicrophone(id);
    if (testing) void start();
  }

  onMount(() => {
    void refresh();
    navigator.mediaDevices?.addEventListener('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh);
  });
  onDestroy(() => { disposed = true; stop(); });
  $effect(() => { if (!voice.current.enabled) stop(); });
</script>

<svelte:window onpagehide={stop} onstorage={(event) => { if (event.key === VOICE_STORAGE_KEY || event.key === null) voice.load(); }} />
<svelte:document onvisibilitychange={() => { if (document.hidden) stop(); }} />

<section class="card" data-testid="voice-input-settings">
  <label class="switch-row">
    <span class="text">{strings.speech.enabled}<span class="hint">{strings.speech.enabledHint}</span></span>
    <input type="checkbox" role="switch" data-testid="voice-enabled" checked={voice.current.enabled} onchange={(event) => voice.setEnabled(event.currentTarget.checked)} />
  </label>
  <div class="switch-row microphone-row">
    <span class="text">{strings.speech.microphone}<span class="hint">{strings.speech.microphoneHint}</span></span>
    <div class="picker">
      <Menu items={inputs} onpick={pick} label={strings.speech.microphone} placement="bottom" align="end" testid="voice-microphone">
        <Mic size={15} /><span class="selected ui-label">{selected}</span><ChevronDown size={14} />
      </Menu>
    </div>
  </div>
  <div class="test-row">
    <button type="button" data-testid="voice-microphone-test" disabled={!voice.current.enabled} onclick={() => phase === 'idle' ? void start() : stop()}>
      <span class="ui-label">{phase === 'idle' ? strings.speech.testMicrophone : strings.speech.stopMicrophoneTest}</span>
    </button>
    <meter min="0" max="1" value={level} aria-label={strings.speech.inputLevel} data-testid="voice-microphone-level"></meter>
  </div>
  <p class="hint" role="status">{phase === 'opening' ? strings.speech.opening : phase === 'listening' ? strings.speech.microphoneTestHint : strings.speech.microphoneIdleHint}</p>
  {#if error}<p class="error" role="alert" data-testid="voice-microphone-error">{error}</p>{/if}
</section>

<style>
  .switch-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 0; }
  .switch-row + .switch-row { border-top: 1px solid var(--color-edge); }
  .text { min-width: 0; }
  .hint { display: block; margin: 4px 0 0; color: var(--color-muted-foreground); font-size: var(--text-xs); line-height: 1.5; }
  .picker { min-width: 0; max-width: 55%; }
  .picker :global(.menu), .picker :global(.trigger) { max-width: 100%; }
  .selected { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .test-row { display: flex; align-items: center; gap: 16px; padding-top: 8px; }
  .test-row button { flex: none; }
  meter { flex: 1; min-width: 0; width: 100%; height: 12px; border-radius: var(--radius-md); background: var(--color-edge); }
  meter::-webkit-meter-bar { background: var(--color-edge); border: none; border-radius: var(--radius-md); }
  meter::-webkit-meter-optimum-value { background: var(--color-accent); border-radius: var(--radius-md); }
  meter::-moz-meter-bar { background: var(--color-accent); border-radius: var(--radius-md); }
  .error { margin: 8px 0 0; color: var(--color-danger); font-size: var(--text-sm); overflow-wrap: anywhere; }
  @media (max-width: 480px) {
    .microphone-row { flex-direction: column; align-items: stretch; gap: 10px; }
    .picker { max-width: 100%; }
    .test-row { gap: 12px; }
  }
</style>
