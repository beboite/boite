<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MonitorPlay, X, Pause, Play, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, RotateCw, Send } from '@lucide/svelte';
  import type { RemoteBrowserFrame, RemoteBrowserInput } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { setExperiment } from '../lib/experiments';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  import { normalizeUrl } from '../lib/browser-bridge';
  import { dragScroll, frameMaxWidth, framePoint, frameQuality, nextPollDelay } from '../lib/remote-browser-view';
  let { store, threadId, surface = false }: { store: Store; threadId: string; surface?: boolean } = $props();
  let shown = $state(untrack(() => surface)), paused = $state(false), busy = $state(false), error = $state(''), text = $state('');
  let frame = $state.raw<RemoteBrowserFrame | null>(null), dialog = $state<HTMLDialogElement>(), picture = $state<HTMLImageElement>();
  // Core timestamps use another device's clock. Retain local age for each frame,
  // including one held by an in-progress pointer gesture.
  const receivedAt = new WeakMap<RemoteBrowserFrame, number>();
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, requestedAt = 0;
  // What the next request asks for and when: see remote-browser-view.ts.
  let roundTrip = 0, unchanged = 0, failures = 0;
  let pointer: { x: number; y: number; lastX: number; lastY: number; moved: boolean; frame: RemoteBrowserFrame; client: Store['client'] } | undefined;
  // Pixels dragged but not yet sent, and where the finger started on the page.
  let scrollX = 0, scrollY = 0, scrolling = false, scrollAt: { x: number; y: number } | null = null;
  let frameClient = $state.raw<Store['client']>(null);
  let displaySettings = $state(false), viewportWidth = $state<number | undefined>(393), viewportHeight = $state<number | undefined>(700);
  let areaWidth = $state(0), areaHeight = $state(0), zoom = $state(0);
  // The PC is not showing this conversation's browser: ask it once per opening, then on demand.
  let hostMissing = $state(false), asking = $state(false), asked = $state(false), notice = $state(''), askedAt = 0;
  /** How long a PC that accepted the request may take to show the tab before the viewer says it did not. */
  const ANSWER_MS = 15_000;
  let address = $state(''), editingAddress = false, fresh = $state(true);
  const previewScale = $derived(frame ? (zoom || Math.min(areaWidth / frame.width, areaHeight / frame.height)) : 1);
  const validSize = $derived([viewportWidth, viewportHeight].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 240 && n <= 3840));
  const enabled = $derived(experimentOn('remote-browser'));
  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let wasEnabled = untrack(() => enabled);
  const usable = $derived(!!frame && frameClient === store.client && !paused && !busy && !error && store.connection === 'ready');
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  function stop() { generation++; clearTimeout(timer); }
  async function poll(run: number): Promise<void> {
    if (!alive || run !== generation || !shown || paused || document.hidden || !enabled) return;
    if (pending || busy) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client, started = performance.now();
    let retry = false;
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const maxWidth = frameMaxWidth(frame ? frame.width * previewScale : areaWidth, window.devicePixelRatio), quality = frameQuality(roundTrip);
      const next = await client.call('browser.remoteFrame', { threadId, ...(maxWidth ? { maxWidth } : {}), ...(quality !== 55 ? { quality } : {}) });
      if (!alive || run !== generation) return;
      if (client === store.client) {
        roundTrip = performance.now() - started; failures = 0;
        unchanged = frame && next.base64 === frame.base64 && next.width === frame.width && next.height === frame.height ? unchanged + 1 : 0;
        receivedAt.set(next, performance.now()); frameClient = client; frame = next; error = ''; fresh = true;
        hostMissing = false; notice = '';
        if (!editingAddress) address = next.url ?? '';
      }
      else { frame = null; frameClient = null; error = strings.remoteBrowser.reconnecting; }
    } catch (cause) {
      if (alive && run === generation) {
        const reason = message(cause);
        // The core spaces frame requests; a refusal for asking early is not a failure.
        if (/wait before requesting/.test(reason)) retry = true;
        else {
          failures++;
          hostMissing = /Open this conversation|open a browser tab|remote-browser experiment|browser host left/.test(reason);
          if (hostMissing && notice && Date.now() - askedAt > ANSWER_MS) notice = strings.remoteBrowser.noAnswer;
          error = hostMissing ? notice || strings.remoteBrowser.hostMissing : reason;
          if (hostMissing && !asked) void ask();
        }
      }
    }
    finally { pending = false; }
    if (alive && run === generation) timer = setTimeout(() => void poll(run), retry ? 250 : nextPollDelay({ roundTrip, unchanged, failures }));
  }
  function resume() {
    stop();
    if (shown && !paused && enabled && !document.hidden) {
      const run = generation;
      timer = setTimeout(() => void poll(run), Math.max(0, 300 - (Date.now() - requestedAt)));
    }
  }
  /** After an input the page moves: the next frame comes at full rate, without dropping one in flight. */
  function kick() {
    unchanged = 0;
    if (pending || !shown || paused || !enabled || document.hidden) return;
    clearTimeout(timer);
    const run = generation;
    timer = setTimeout(() => void poll(run), Math.max(60, 250 - (Date.now() - requestedAt)));
  }
  /** Asks the PC to show this conversation and a browser tab: away from the PC, nobody else can. */
  async function ask(): Promise<void> {
    const client = store.client;
    if (!client || client.state !== 'ready' || asking) return;
    asked = true; asking = true;
    try {
      await client.call('browser.remoteOpen', { threadId });
      if (alive && client === store.client) { askedAt = Date.now(); notice = strings.remoteBrowser.asking; if (hostMissing) error = notice; failures = 0; kick(); }
    } catch (cause) {
      if (alive && client === store.client) error = /No desktop is sharing/.test(message(cause)) ? strings.remoteBrowser.noDesktop : message(cause);
    } finally { asking = false; }
  }
  onMount(() => {
    const visibility = () => { if (document.hidden) { stop(); fresh = false; } else resume(); };
    // A phone back from the background, a reopened PWA or a returning network resumes at once.
    const back = () => { if (!document.hidden && !pending) resume(); };
    document.addEventListener('visibilitychange', visibility);
    for (const name of ['pageshow', 'online', 'focus'] as const) window.addEventListener(name, back);
    return () => {
      alive = false; stop(); document.removeEventListener('visibilitychange', visibility);
      for (const name of ['pageshow', 'online', 'focus'] as const) window.removeEventListener(name, back);
    };
  });
  $effect(() => {
    if (!enabled) { if (wasEnabled) shown = false; frame = null; text = ''; }
    wasEnabled = enabled;
    const ready = store.connection === 'ready';
    if (shown && !paused && enabled) untrack(() => { if (ready) failures = 0; resume(); }); else untrack(stop);
  });
  $effect(() => {
    if (!shown || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { shown = false; });
    return () => { release(); node.close(); text = ''; asked = false; notice = ''; restoreFocus(previous); };
  });
  async function input(value: RemoteBrowserInput, target = frame): Promise<boolean> {
    const client = store.client;
    if (!client || frameClient !== client || !target || !usable || performance.now() - (receivedAt.get(target) ?? -Infinity) > 5000) return false;
    const resizing = value.kind === 'viewport' || value.kind === 'reset-viewport';
    const moving = resizing || value.kind === 'navigate' || value.kind === 'history' || value.kind === 'reload';
    if (resizing) { stop(); displaySettings = false; pointer = undefined; }
    const run = generation;
    busy = true;
    try {
      await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value });
      if (alive && run === generation && client === store.client && value.kind === 'text') text = '';
      // Those retire the frame on the PC: show it as stale until the next one.
      if (moving) fresh = false;
      return true;
    }
    catch (cause) { if (alive && run === generation && client === store.client) error = message(cause); return false; }
    finally {
      busy = false;
      if (resizing && alive && run === generation) { frame = null; frameClient = null; resume(); }
      else if (alive) kick();
    }
  }
  function resize(width: number, height: number) {
    viewportWidth = Math.max(240, Math.min(3840, Math.round(width)));
    viewportHeight = Math.max(240, Math.min(3840, Math.round(height)));
    zoom = 0;
    void input({ kind: 'viewport', width: viewportWidth, height: viewportHeight });
  }
  function point(event: PointerEvent, current: RemoteBrowserFrame) {
    return picture ? framePoint(picture.getBoundingClientRect(), current, event.clientX, event.clientY) : null;
  }
  function down(event: PointerEvent) {
    if (!usable || !frame || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, frame, client: frameClient };
    scrollX = 0; scrollY = 0; scrollAt = point(event, frame);
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture(event.pointerId);
  }
  /** The page follows the finger while it moves: one wheel in flight, the rest added to the next. */
  function flushScroll() {
    const target = frame, client = store.client, at = scrollAt;
    if (scrolling || (!scrollX && !scrollY) || !target || !client || frameClient !== client || performance.now() - (receivedAt.get(target) ?? -Infinity) > 5000) return;
    const delta = dragScroll(scrollX, scrollY, picture?.getBoundingClientRect().width ?? 0, target.width);
    scrollX = 0; scrollY = 0;
    if (!delta.x && !delta.y) return;
    scrolling = true;
    void client.call('browser.remoteInput', { threadId, frameId: target.id, input: { kind: 'scroll', ...delta, ...(at ? { at } : {}) } })
      .catch(() => {})
      .finally(() => { scrolling = false; kick(); flushScroll(); });
  }
  function move(event: PointerEvent) {
    const start = pointer;
    if (!start || zoom) return;
    if (!start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) return;
    start.moved = true;
    scrollX += event.clientX - start.lastX; scrollY += event.clientY - start.lastY;
    start.lastX = event.clientX; start.lastY = event.clientY;
    flushScroll();
  }
  function up(event: PointerEvent) {
    const start = pointer; pointer = undefined;
    if (!start || start.client !== store.client) return;
    if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      if (zoom) return; // Enlarged previews pan locally; arrow buttons scroll the shared page.
      scrollX += event.clientX - start.lastX; scrollY += event.clientY - start.lastY;
      flushScroll();
    } else { const p = point(event, start.frame); if (p) void input({ kind: 'tap', ...p, width: start.frame.width, height: start.frame.height }, start.frame); }
  }
  function go(event: SubmitEvent) {
    event.preventDefault();
    const url = normalizeUrl(address);
    if (!url) { error = strings.remoteBrowser.badAddress; return; }
    (document.activeElement as HTMLElement | null)?.blur?.();
    editingAddress = false; address = url;
    void input({ kind: 'navigate', url });
  }
  async function sendText(enter: boolean) {
    const value = text;
    if (value && !await input({ kind: 'text', text: value })) return;
    if (enter) await input({ kind: 'key', key: 'Enter' });
  }
  /** iOS sends Return and an erase on an empty field as key events: they act on the page. */
  function textKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); void sendText(true); }
    else if (event.key === 'Backspace' && text === '') { event.preventDefault(); void input({ kind: 'key', key: 'Backspace' }); }
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
    <form class="nav" data-testid="remote-browser-nav" onsubmit={go}>
      <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.back} onclick={() => void input({ kind: 'history', direction: 'back' })}><ArrowLeft size={17} /></button>
      <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.forward} onclick={() => void input({ kind: 'history', direction: 'forward' })}><ArrowRight size={17} /></button>
      <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.reload} onclick={() => void input({ kind: 'reload' })}><RotateCw size={16} /></button>
      <input bind:value={address} data-testid="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.address} onfocus={e => { editingAddress = true; e.currentTarget.select(); }} onblur={() => { editingAddress = false; }} />
      <button type="submit" class="chip go" disabled={!usable || !address.trim()}>{strings.remoteBrowser.go}</button>
    </form>
    <div class="toolbar"><span class="state" class:live={frame && !paused && !error}>{paused ? strings.remoteBrowser.paused : error && (hostMissing || asking || notice || error === strings.remoteBrowser.noDesktop) ? strings.remoteBrowser.waiting : error ? strings.remoteBrowser.reconnecting : frame ? strings.remoteBrowser.live : strings.remoteBrowser.waiting}</span>
      <button type="button" class="chip" data-testid="remote-browser-display" aria-expanded={displaySettings} onclick={() => { displaySettings = !displaySettings; if (frame) { viewportWidth = frame.width; viewportHeight = frame.height; } }}>{strings.remoteBrowser.display}</button>
      <button type="button" class="chip" onclick={() => { paused = !paused; }}>{#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}{paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause}</button></div>
    {#if error}<div class="error" class:notice={error === notice} role="status" data-testid="remote-browser-error"><p>{error}</p>{#if hostMissing}<button type="button" class="chip" data-testid="remote-browser-ask" disabled={asking} onclick={() => void ask()}>{strings.remoteBrowser.askPc}</button>{/if}</div>{/if}
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
        <button type="button" class="screen" style:width={`${frame.width * previewScale}px`} style:height={`${frame.height * previewScale}px`} class:stale={paused || error || !fresh} aria-label={strings.remoteBrowser.interact} disabled={!usable} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => { pointer = undefined; }} oncontextmenu={e => e.preventDefault()}>
          <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={strings.remoteBrowser.image} draggable="false" data-testid="remote-browser-frame" />
        </button>
      {:else}<p class="empty">{strings.remoteBrowser.help}</p>{/if}
    </div>
    </div>
    <footer>
      <div class="keys"><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: -500 })} aria-label={strings.remoteBrowser.scrollUp}><ArrowUp size={17} /></button><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: 500 })} aria-label={strings.remoteBrowser.scrollDown}><ArrowDown size={17} /></button>
        {#each (['Tab', 'Enter', 'Escape', 'Backspace'] as const) as key}<button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'key', key })}>{key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}</button>{/each}
      </div>
      <form onsubmit={e => { e.preventDefault(); void sendText(false); }}><input bind:value={text} data-testid="remote-browser-text" maxlength="2000" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={strings.remoteBrowser.text} placeholder={strings.remoteBrowser.text} onkeydown={textKey} /><button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.remoteBrowser.send}><Send size={17} /></button></form>
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
  small, .empty { color: var(--color-muted-foreground); font-size: var(--text-sm); } .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 16px 8px; } .state { font-size: var(--text-sm); } .live { color: var(--color-accent); }
  .nav { padding: 8px 16px; gap: 6px; align-items: center; } .nav .chip { flex: none; } .nav .go { padding-inline: 12px; }
  .viewer { position: relative; flex: 1; min-height: 80px; overflow: hidden; }
  .screen-area { width: 100%; height: 100%; display: flex; background: var(--color-background); overflow: auto; }
  .screen { flex: none; margin: auto; }
  .zoomed .screen { touch-action: pan-x pan-y; }
  .display-settings { position: absolute; z-index: 1; inset: 0 0 auto; max-height: 100%; overflow: auto; padding: 12px 16px; display: grid; gap: 10px; background: var(--color-surface); border-bottom: 1px solid var(--color-border); box-shadow: var(--shadow-e3); }
  .display-settings strong { font-size: var(--text-sm); } .options { display: flex; flex-wrap: wrap; gap: 6px; }
  .display-settings label { flex: 1; min-width: 0; font-size: var(--text-sm); } .display-settings input { width: 100%; } .display-settings form { align-items: flex-end; }
  .options [aria-pressed=true] { color: var(--color-accent); border-color: var(--color-accent); }
  .screen { width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; touch-action: none; cursor: crosshair; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; } .screen:disabled { opacity: 1; } .screen.stale { opacity: .55; } img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; -webkit-user-select: none; user-select: none; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); display: grid; gap: 8px; } .keys { display: flex; gap: 6px; flex-wrap: wrap; } .chip { min-height: 44px; min-width: 44px; justify-content: center; } form { display: flex; gap: 8px; } input { min-width: 0; flex: 1; font-size: 16px; min-height: 44px; }
  .error { display: flex; align-items: center; gap: 8px; padding: 0 16px 8px; } .error p { flex: 1; margin: 0; font-size: var(--text-sm); color: var(--color-danger); max-height: 90px; overflow: auto; overflow-wrap: anywhere; } .error.notice p { color: var(--color-muted-foreground); } .error .chip { flex: none; } .empty { padding: 24px; }
  @media (max-width: 720px) { .launcher span { display: inline; } .launcher { min-height: var(--touch-target); } dialog { position: fixed; inset: var(--app-top, 0px) 0 auto; margin: 0; width: 100%; max-width: 100%; height: var(--app-height, 100dvh); max-height: var(--app-height, 100dvh); border: 0; border-radius: 0; } header { padding-top: max(12px, env(safe-area-inset-top)); } footer small { display: none; } .nav, .toolbar, footer { padding-inline: 12px; } .nav { gap: 4px; } }
</style>
