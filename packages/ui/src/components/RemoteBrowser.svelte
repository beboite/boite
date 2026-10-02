<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MonitorPlay, X, Pause, Play, ArrowUp, ArrowDown, Send } from '@lucide/svelte';
  import type { RemoteBrowserFrame, RemoteBrowserInput } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { setExperiment } from '../lib/experiments';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  let { store, threadId, surface = false }: { store: Store; threadId: string; surface?: boolean } = $props();
  let shown = $state(untrack(() => surface)), paused = $state(false), busy = $state(false), error = $state(''), text = $state('');
  let frame = $state.raw<RemoteBrowserFrame | null>(null), dialog = $state<HTMLDialogElement>(), picture = $state<HTMLImageElement>();
  // Core timestamps use another device's clock. Retain local age for each frame,
  // including one held by an in-progress pointer gesture.
  const receivedAt = new WeakMap<RemoteBrowserFrame, number>();
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, requestedAt = 0;
  let pointer: { x: number; y: number; frame: RemoteBrowserFrame; client: Store['client'] } | undefined;
  let frameClient = $state.raw<Store['client']>(null);
  let displaySettings = $state(false), viewportWidth = $state<number | undefined>(393), viewportHeight = $state<number | undefined>(700);
  let areaWidth = $state(0), areaHeight = $state(0), zoom = $state(0);
  const previewScale = $derived(frame ? (zoom || Math.min(areaWidth / frame.width, areaHeight / frame.height)) : 1);
  const validSize = $derived([viewportWidth, viewportHeight].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 240 && n <= 3840));
  const enabled = $derived(experimentOn('remote-browser'));
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let wasEnabled = untrack(() => enabled);
  const usable = $derived(!!frame && frameClient === store.client && !paused && !busy && !error && store.connection === 'ready');
  function stop() { generation++; clearTimeout(timer); }
  async function poll(run: number): Promise<void> {
    if (!alive || run !== generation || !shown || paused || document.hidden || !enabled) return;
    if (pending || busy) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client;
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const next = await client.call('browser.remoteFrame', { threadId });
      if (!alive || run !== generation) return;
      if (client === store.client) { receivedAt.set(next, performance.now()); frameClient = client; frame = next; error = ''; }
      else { frame = null; frameClient = null; error = strings.remoteBrowser.reconnecting; }
    } catch (cause) {
      if (alive && run === generation) {
        const message = cause instanceof Error ? cause.message : String(cause);
        error = /Open this conversation|open a browser tab|remote-browser experiment/.test(message) ? strings.remoteBrowser.hostMissing : message;
      }
    }
    finally { pending = false; }
    if (alive && run === generation) timer = setTimeout(() => void poll(run), error ? 1800 : 300);
  }
  function resume() {
    stop();
    if (shown && !paused && enabled && !document.hidden) {
      const run = generation;
      timer = setTimeout(() => void poll(run), Math.max(0, 300 - (Date.now() - requestedAt)));
    }
  }
  onMount(() => {
    const visibility = () => { if (document.hidden) stop(); else resume(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { alive = false; stop(); document.removeEventListener('visibilitychange', visibility); };
  });
  $effect(() => {
    if (!enabled) { if (wasEnabled) shown = false; frame = null; text = ''; }
    wasEnabled = enabled;
    if (shown && !paused && enabled) untrack(resume); else untrack(stop);
  });
  $effect(() => {
    if (!shown || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { shown = false; });
    return () => { release(); node.close(); text = ''; restoreFocus(previous); };
  });
  async function input(value: RemoteBrowserInput, target = frame): Promise<void> {
    const client = store.client;
    if (!client || frameClient !== client || !target || !usable || performance.now() - (receivedAt.get(target) ?? -Infinity) > 5000) return;
    const resizing = value.kind === 'viewport' || value.kind === 'reset-viewport';
    if (resizing) { stop(); displaySettings = false; pointer = undefined; }
    const run = generation;
    busy = true;
    try { await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value }); if (alive && run === generation && client === store.client && value.kind === 'text') text = ''; }
    catch (cause) { if (alive && run === generation && client === store.client) error = String(cause); }
    finally {
      busy = false;
      if (resizing && alive && run === generation) { frame = null; frameClient = null; resume(); }
    }
  }
  function resize(width: number, height: number) {
    viewportWidth = Math.max(240, Math.min(3840, Math.round(width)));
    viewportHeight = Math.max(240, Math.min(3840, Math.round(height)));
    zoom = 0;
    void input({ kind: 'viewport', width: viewportWidth, height: viewportHeight });
  }
  function point(event: PointerEvent, current: RemoteBrowserFrame) {
    if (!picture) return null;
    const r = picture.getBoundingClientRect(), scale = Math.min(r.width / current.width, r.height / current.height);
    const width = current.width * scale, height = current.height * scale;
    const x = (event.clientX - r.left - (r.width - width) / 2) / width, y = (event.clientY - r.top - (r.height - height) / 2) / height;
    return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
  }
  function down(event: PointerEvent) {
    if (!usable || !frame || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, frame, client: frameClient };
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture(event.pointerId);
  }
  function up(event: PointerEvent) {
    const start = pointer; pointer = undefined;
    if (!start || start.client !== store.client) return;
    const dx = start.x - event.clientX, dy = start.y - event.clientY;
    if (Math.hypot(dx, dy) > 8) {
      if (zoom) return; // Enlarged previews pan locally; arrow buttons scroll the shared page.
      const ratio = start.frame.width / (picture?.getBoundingClientRect().width || start.frame.width);
      void input({ kind: 'scroll', x: Math.max(-2000, Math.min(2000, dx * ratio)), y: Math.max(-2000, Math.min(2000, dy * ratio)) }, start.frame);
    } else { const p = point(event, start.frame); if (p) void input({ kind: 'tap', ...p, width: start.frame.width, height: start.frame.height }, start.frame); }
  }
</script>

{#if surface}
  <div class="surface-launcher"><MonitorPlay size={28} /><h2>{strings.remoteBrowser.title}</h2><p>{strings.remoteBrowser.hint}</p><button type="button" class="primary" data-testid="remote-browser-open" onclick={() => { shown = true; paused = false; }}>{strings.remoteBrowser.open}</button></div>
{:else if enabled || !inShell}
  <button type="button" class="ghost small launcher" data-testid="remote-browser-open" title={strings.remoteBrowser.title} aria-label={strings.remoteBrowser.title} onclick={() => { shown = true; paused = false; }}><MonitorPlay size={16} /><span>{strings.rightPanel.browser}</span></button>
{/if}
{#if shown}
  <dialog bind:this={dialog} data-testid="remote-browser-dialog" aria-label={strings.remoteBrowser.title} onkeydown={e => e.stopPropagation()} oncancel={e => { e.preventDefault(); shown = false; }}>
    <header><div><h2>{strings.remoteBrowser.title}</h2><small>{frame?.title || strings.remoteBrowser.waiting}</small></div><button type="button" class="ghost icon" aria-label={strings.imports.close} onclick={() => { shown = false; }}><X size={18} /></button></header>
    {#if !enabled}
      <section class="setup" data-testid="remote-browser-setup"><MonitorPlay size={32} /><h2>{strings.remoteBrowser.experimental}</h2><p>{strings.remoteBrowser.hint}</p><p>{strings.remoteBrowser.help}</p><button type="button" class="primary" data-testid="remote-browser-enable" onclick={() => setExperiment('remote-browser', true)}>{strings.remoteBrowser.enable}</button></section>
    {:else}
    <div class="toolbar"><span class="state" class:live={frame && !paused && !error}>{paused ? strings.remoteBrowser.paused : error ? strings.remoteBrowser.reconnecting : frame ? strings.remoteBrowser.live : strings.remoteBrowser.waiting}</span>
      <button type="button" class="chip" data-testid="remote-browser-display" aria-expanded={displaySettings} onclick={() => { displaySettings = !displaySettings; if (frame) { viewportWidth = frame.width; viewportHeight = frame.height; } }}>{strings.remoteBrowser.display}</button>
      <button type="button" class="chip" onclick={() => { paused = !paused; }}>{#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}{paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause}</button></div>
    {#if error}<p class="error" role="status">{error}</p>{/if}
    <div class="viewer">
    {#if displaySettings}
      <section class="display-settings" aria-label={strings.remoteBrowser.display}>
        <strong>{strings.remoteBrowser.resolution} {frame ? `${frame.width} × ${frame.height}` : ''}</strong>
        <div class="options">
          <button class="chip" disabled={!usable} onclick={() => resize(areaWidth, areaHeight)}>{strings.remoteBrowser.fitPhone}</button>
          <button class="chip" disabled={!usable} onclick={() => resize(393, 700)}>{strings.remoteBrowser.phone}</button>
          <button class="chip" disabled={!usable} onclick={() => resize(768, 1024)}>{strings.remoteBrowser.tablet}</button>
          <button class="chip" disabled={!usable} onclick={() => resize(1366, 768)}>PC</button>
          <button class="chip" disabled={!usable || !frame} onclick={() => frame && resize(frame.height, frame.width)}>{strings.remoteBrowser.rotate}</button>
        </div>
        <form onsubmit={e => { e.preventDefault(); if (validSize) resize(viewportWidth!, viewportHeight!); }}>
          <label>{strings.remoteBrowser.width}<input type="number" min="240" max="3840" step="1" required bind:value={viewportWidth} /></label>
          <label>{strings.remoteBrowser.height}<input type="number" min="240" max="3840" step="1" required bind:value={viewportHeight} /></label>
          <button class="chip" type="submit" disabled={!usable || !validSize}>{strings.remoteBrowser.apply}</button>
        </form>
        <small>{strings.remoteBrowser.sharedSize}</small>
        <button class="chip" disabled={!usable} onclick={() => void input({ kind: 'reset-viewport' })}>{strings.remoteBrowser.restoreSize}</button>
        <strong>{strings.remoteBrowser.previewZoom}</strong>
        <div class="options">
          <button class="chip" aria-pressed={zoom === 0} onclick={() => { zoom = 0; displaySettings = false; }}>{strings.remoteBrowser.fit}</button>
          {#each [1, 1.5, 2] as scale}<button class="chip" aria-pressed={zoom === scale} onclick={() => { zoom = scale; displaySettings = false; }}>{scale * 100}%</button>{/each}
        </div>
      </section>
    {/if}
    <div class="screen-area" class:zoomed={zoom > 0} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
      {#if frame}
        <button type="button" class="screen" style:width={`${frame.width * previewScale}px`} style:height={`${frame.height * previewScale}px`} class:stale={paused || error} aria-label={strings.remoteBrowser.interact} disabled={!usable} onpointerdown={down} onpointerup={up} onpointercancel={() => { pointer = undefined; }}>
          <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={strings.remoteBrowser.image} draggable="false" data-testid="remote-browser-frame" />
        </button>
      {:else}<p class="empty">{strings.remoteBrowser.help}</p>{/if}
    </div>
    </div>
    <footer>
      <div class="keys"><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: -500 })} aria-label={strings.remoteBrowser.scrollUp}><ArrowUp size={17} /></button><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: 500 })} aria-label={strings.remoteBrowser.scrollDown}><ArrowDown size={17} /></button>
        {#each (['Tab', 'Enter', 'Escape', 'Backspace'] as const) as key}<button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'key', key })}>{key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}</button>{/each}
      </div>
      <form onsubmit={e => { e.preventDefault(); void input({ kind: 'text', text }); }}><input bind:value={text} maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label={strings.remoteBrowser.text} placeholder={strings.remoteBrowser.text} /><button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.remoteBrowser.send}><Send size={17} /></button></form>
      <small>{zoom ? strings.remoteBrowser.panHint : strings.remoteBrowser.gesture}</small>
    </footer>
    {/if}
  </dialog>
{/if}

<style>
  .launcher { gap: 6px; }
  .launcher span { display: none; }
  .setup, .surface-launcher { margin: auto; max-width: 480px; padding: 28px 24px; display: flex; flex-direction: column; align-items: flex-start; gap: 16px; }
  .setup p, .surface-launcher p { margin: 0; color: var(--color-muted-foreground); font-size: var(--text-sm); line-height: 1.6; }
  .setup button, .surface-launcher button { min-height: var(--touch-target); }
  dialog { width: min(1100px, calc(100vw - 24px)); height: min(850px, calc(100dvh - 24px)); padding: 0; margin: auto; border: 1px solid var(--color-edge); border-radius: var(--radius-xl); color: var(--color-foreground); background: var(--color-surface); box-shadow: var(--shadow-e3); }
  dialog[open] { display: flex; flex-direction: column; } dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--color-border); } header div { flex: 1; min-width: 0; } h2 { margin: 0 0 4px; font-size: var(--text-md); } header small { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  small, .empty { color: var(--color-muted-foreground); font-size: var(--text-sm); } .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; } .state { font-size: var(--text-sm); } .live { color: var(--color-accent); }
  .viewer { position: relative; flex: 1; min-height: 80px; overflow: hidden; }
  .screen-area { width: 100%; height: 100%; display: flex; background: var(--color-background); overflow: auto; }
  .screen { flex: none; margin: auto; }
  .zoomed .screen { touch-action: pan-x pan-y; }
  .display-settings { position: absolute; z-index: 1; inset: 0 0 auto; max-height: 100%; overflow: auto; padding: 12px 16px; display: grid; gap: 10px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); box-shadow: var(--shadow-e3); }
  .display-settings strong { font-size: var(--text-sm); } .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .display-settings label { flex: 1; min-width: 0; font-size: var(--text-sm); } .display-settings input { width: 100%; } .display-settings form { align-items: flex-end; }
  .options [aria-pressed=true] { color: var(--color-accent); border-color: var(--color-accent); }
  .screen { width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; touch-action: none; cursor: crosshair; } .screen:disabled { opacity: 1; } .screen.stale { opacity: .55; } img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); display: grid; gap: 8px; } .keys { display: flex; gap: 6px; flex-wrap: wrap; } .chip { min-height: 44px; min-width: 44px; justify-content: center; } form { display: flex; gap: 8px; } input { min-width: 0; flex: 1; font-size: 16px; min-height: 44px; } .error { margin: 0; padding: 8px 16px; font-size: var(--text-sm); color: var(--color-danger); max-height: 90px; overflow: auto; overflow-wrap: anywhere; } .empty { padding: 24px; }
  @media (max-width: 720px) { .launcher span { display: inline; } .launcher { min-height: var(--touch-target); } dialog { position: fixed; inset: var(--app-top, 0px) 0 auto; margin: 0; width: 100%; max-width: 100%; height: var(--app-height, 100dvh); max-height: var(--app-height, 100dvh); border: 0; border-radius: 0; } header { padding-top: max(12px, env(safe-area-inset-top)); } }
</style>
