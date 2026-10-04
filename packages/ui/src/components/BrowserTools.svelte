<script lang="ts">
  import { BROWSER_PRESETS, BROWSER_RECORDING_CODECS, BROWSER_RECORDING_CODEC_LABELS, BROWSER_RECORDING_FRAME_RATES, BROWSER_RECORDING_MAX_BYTES, BROWSER_RECORDING_TYPES, type BrowserAction, type BrowserDiagnostics, type BrowserPreset, type BrowserRecordingCodec, type BrowserRecordingFrameRate } from '@boite/contracts';
  import { MonitorSmartphone, Circle, Square, X, Download, RefreshCw, Trash2 } from '@lucide/svelte';
  import { browserTools, runBrowserAction } from '../lib/browser-tools.svelte';
  import { strings, fill } from '../lib/strings';
  import { separator, type MenuItem } from '../lib/menu';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { recordingCodec, recordingFrameRate, setRecordingCodec, setRecordingFrameRate } from '../lib/recording-settings';
  import { recordingVideoType, supportedRecordingCodecs, warmRecordingEncoder } from '../lib/browser-recording';
  import { videoPlayable } from '../lib/video-support';
  import Menu from './Menu.svelte';
  let { id, onerror }: { id: string; onerror: (message: string) => void } = $props();
  const toolsState = $derived(browserTools(id));
  let busy = $state(false);
  let frameRate = $state(recordingFrameRate());
  let codec = $state(recordingCodec());
  // Asked once: what this desktop's engine encodes does not change while it runs.
  const codecs = supportedRecordingCodecs();
  // The recording whose video this view failed to play.
  let unplayable = $state<string | null>(null);
  const playable = $derived(!!toolsState.result && unplayable !== toolsState.result.id && videoPlayable(recordingVideoType(toolsState.result.codec)));
  const format = $derived(toolsState.result ? `${toolsState.result.codec ? `${BROWSER_RECORDING_CODEC_LABELS[toolsState.result.codec]} ` : ''}${BROWSER_RECORDING_TYPES[toolsState.result.mime].toUpperCase()}` : '');
  let view = $state<'diagnostics' | 'recording' | null>(null);
  let dialog = $state<HTMLDialogElement>();
  let report = $state<BrowserDiagnostics>({ entries: [], dropped: 0, history: [] });
  let seenResult: string | undefined;
  $effect(() => {
    if (toolsState.result && toolsState.result.id !== seenResult) { seenResult = toolsState.result.id; view = 'recording'; }
    else if (!toolsState.result && view === 'recording') view = null;
  });
  $effect(() => {
    if (!view || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { view = null; });
    return () => { release(); node.close(); restoreFocus(previous); };
  });
  async function act(action: BrowserAction): Promise<void> {
    if (busy) return;
    busy = true;
    try { await runBrowserAction(id, action); }
    catch (error) { onerror(String(error)); }
    finally { busy = false; }
  }
  async function diagnostics(clear = false): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      if (clear) await runBrowserAction(id, { kind: 'diagnostics', clear: true });
      report = (await runBrowserAction(id, { kind: 'diagnostics' })).value as BrowserDiagnostics;
      view = 'diagnostics';
    } catch (error) { onerror(String(error)); }
    finally { busy = false; }
  }
  const items = $derived.by((): MenuItem[] => [
    { id: 'fill', label: strings.browser.resetViewport },
    ...Object.entries(BROWSER_PRESETS).map(([key, value]) => ({ id: `preset:${key}`, label: `${key.startsWith('desktop') ? strings.browserTools.desktop : key.startsWith('laptop') ? strings.browserTools.laptop : value.label} · ${value.width} × ${value.height}`, active: toolsState.preset === key })),
    { id: 'rotate', label: toolsState.orientation === 'portrait' ? strings.browserTools.landscape : strings.browserTools.portrait, disabled: !toolsState.preset },
    separator('appearance'),
    ...(['system', 'light', 'dark'] as const).map(value => ({ id: `appearance:${value}`, label: strings.browserTools[value], active: toolsState.colorScheme === value })),
    separator('before-diagnostics'),
    { id: 'diagnostics', label: strings.browserTools.diagnostics },
    separator('frame-rate'),
    ...BROWSER_RECORDING_FRAME_RATES.map(rate => ({ id: `fps:${rate}`, label: fill(strings.browserTools.frameRate, { rate: String(rate) }), active: frameRate === rate })),
    separator('codec'),
    ...BROWSER_RECORDING_CODECS.map(value => ({ id: `codec:${value}`, label: fill(strings.browserTools.codec, { codec: BROWSER_RECORDING_CODEC_LABELS[value] }), active: codec === value,
      ...(codecs[value] ? {} : { disabled: true, hint: strings.browserTools.codecUnavailable }) })),
    ...(toolsState.result ? [{ id: 'recording', label: strings.browserTools.reviewRecording }] : []),
  ]);
  function pick(value: string) {
    if (value === 'fill') void act({ kind: 'reset-viewport' });
    else if (value.startsWith('preset:')) void act({ kind: 'preset', preset: value.slice(7) as BrowserPreset });
    else if (value.startsWith('appearance:')) void act({ kind: 'appearance', colorScheme: value.slice(11) as 'system' | 'dark' | 'light' });
    else if (value === 'rotate' && toolsState.preset) void act({ kind: 'preset', preset: toolsState.preset, orientation: toolsState.orientation === 'portrait' ? 'landscape' : 'portrait' });
    else if (value === 'diagnostics') void diagnostics();
    else if (value.startsWith('fps:')) { frameRate = Number(value.slice(4)) as BrowserRecordingFrameRate; setRecordingFrameRate(frameRate); }
    else if (value.startsWith('codec:')) { codec = value.slice(6) as BrowserRecordingCodec; setRecordingCodec(codec); warmRecordingEncoder(codec); }
    else if (value === 'recording') view = 'recording';
  }
</script>

<Menu {items} onpick={pick} label={strings.browserTools.title} placement="bottom" align="end" variant="ghost" testid="browser-tools">
  <MonitorSmartphone size={15} />
</Menu>
<button type="button" class="ghost small icon record" class:active={toolsState.recording} disabled={busy || (!!toolsState.result && !toolsState.recording)}
  data-testid="browser-record" aria-pressed={toolsState.recording} title={toolsState.recording ? strings.browserTools.stopRecording : strings.browserTools.startRecording}
  aria-label={toolsState.recording ? strings.browserTools.stopRecording : strings.browserTools.startRecording}
  onclick={() => void act({ kind: toolsState.recording ? 'recording-stop' : 'recording-start' })}>
  {#if toolsState.recording}<Square size={14} fill="currentColor" />{:else}<Circle size={14} />{/if}
</button>
{#if view}
  <dialog bind:this={dialog} data-testid="browser-tools-dialog" aria-label={view === 'diagnostics' ? strings.browserTools.diagnostics : strings.browserTools.reviewRecording}
    onkeydown={event => event.stopPropagation()} oncancel={event => { event.preventDefault(); view = null; }}>
    <header><h2>{view === 'diagnostics' ? strings.browserTools.diagnostics : strings.browserTools.reviewRecording}</h2>
      <button type="button" class="ghost small icon" aria-label={strings.imports.close} onclick={() => { view = null; }}><X size={16} /></button></header>
    <div class="body">
      {#if view === 'diagnostics'}
        <div class="actions">
          <button type="button" class="chip" disabled={busy} onclick={() => void diagnostics()}><RefreshCw size={14} /><span class="ui-label">{strings.browserTools.refresh}</span></button>
          <button type="button" class="chip" disabled={busy} onclick={() => void diagnostics(true)}><Trash2 size={14} /><span class="ui-label">{strings.browserTools.clear}</span></button>
        </div>
        <h3>{strings.browserTools.pageEvents}</h3>
        {#if report.dropped}<p class="muted">{fill(strings.browserTools.omitted, { count: String(report.dropped) })}</p>{/if}
        {#if !report.entries.length}<p class="muted">{strings.browserTools.noEvents}</p>{/if}
        <ol data-testid="browser-diagnostics">{#each report.entries as entry}<li class:error={entry.level === 'error'}><small>{entry.kind} · {entry.level}</small><pre>{entry.text}</pre>{#if entry.url}<small>{entry.url}</small>{/if}</li>{/each}</ol>
        <h3>{strings.browserTools.actions}</h3>
        {#if !report.history.length}<p class="muted">{strings.browserTools.noActions}</p>{/if}
        <ol>{#each report.history as entry}<li class:error={!entry.ok}><span>{entry.ok ? '✓' : '×'} {entry.action} · {entry.durationMs} ms</span>{#if entry.error}<pre>{entry.error}</pre>{/if}</li>{/each}</ol>
      {:else if toolsState.result && toolsState.url}
        <!-- svelte-ignore a11y_media_has_caption -->
        {#if playable}<video controls src={toolsState.url} data-testid="browser-recording-preview" onerror={() => { unplayable = toolsState.result?.id ?? null; }}></video>
        {:else}<p role="status" data-testid="browser-recording-unplayable">{fill(strings.browserTools.unplayable, { codec: BROWSER_RECORDING_CODEC_LABELS[toolsState.result.codec ?? 'h264'] })}</p>{/if}
        <p class="muted">{fill(strings.browserTools.recorded, { seconds: String(Math.round(toolsState.result.durationMs / 1000)), fps: String(toolsState.result.frameRate ?? 30), mb: (toolsState.result.bytes / 1024 / 1024).toFixed(1), format })}</p>
        {#if toolsState.result.reason !== 'stopped'}<p role="status" data-testid="browser-recording-reason">{toolsState.result.reason === 'error' ? strings.browserTools.recordingError : fill(strings.browserTools.recordingLimit, { mb: String(BROWSER_RECORDING_MAX_BYTES / 1024 / 1024) })}{toolsState.result.error ? ` ${toolsState.result.error}` : ''}</p>{/if}
        <div class="actions">
          <a class="chip" href={toolsState.url} download={`boite-browser-${toolsState.result.id}.${BROWSER_RECORDING_TYPES[toolsState.result.mime]}`} data-testid="browser-recording-download"><Download size={14} /><span class="ui-label">{strings.browserTools.download}</span></a>
          <button type="button" class="chip" onclick={() => { void act({ kind: 'recording-discard', recordingId: toolsState.result!.id }); view = null; }}><Trash2 size={14} /><span class="ui-label">{strings.browserTools.discard}</span></button>
        </div>
      {/if}
    </div>
  </dialog>
{/if}

<style>
  .active { color: var(--color-danger); background: var(--color-accent-soft); }
  dialog { width: min(720px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); margin: auto; padding: 0; color: var(--color-foreground); background: var(--color-surface); border: 1px solid var(--color-edge); border-radius: var(--radius-xl); box-shadow: var(--shadow-e3); }
  dialog[open] { display: flex; flex-direction: column; }
  dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--color-border); }
  h2 { flex: 1; margin: 0; font-size: var(--text-md); } h3 { font-size: var(--text-sm); margin: 20px 0 8px; }
  .body { overflow: auto; padding: 16px 18px; min-height: 0; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .actions .chip { min-height: 36px; gap: 8px; padding: 8px 12px; text-decoration: none; }
  @media (max-width: 720px) { .actions .chip { min-height: 44px; } }
  ol { padding: 0; list-style: none; } li { border-bottom: 1px solid var(--color-border); padding: 8px 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; margin: 4px 0; font-size: var(--text-sm); } small, .muted { color: var(--color-muted-foreground); }
  .error pre { color: var(--color-danger); }
  video { display: block; width: 100%; max-height: 55dvh; border-radius: var(--radius-md); background: var(--color-background); }
</style>
