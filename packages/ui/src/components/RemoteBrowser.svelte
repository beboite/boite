<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Pause, Play, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Copy, RotateCw, Send } from '@lucide/svelte';
  import { REMOTE_PRESS_MAX, REMOTE_TEXT_MAX, type RemoteBrowserFrame, type RemoteBrowserInput } from '@boite/contracts';
  import { browserKey, hasKeyboard, liveInput, writeClipboardLater } from '../lib/live-input';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { normalizeUrl } from '../lib/browser-bridge';
  import { dragScroll, FRAME_INTERVAL, frameMaxWidth, framePoint, frameQuality, nextPollDelay } from '../lib/remote-browser-view';
  /**
   * One tab of the browser the conversation's agent drives on the machine that
   * runs it, watched and driven from any client. Without `tabId`, the agent's
   * active tab.
   */
  let { store, threadId, tabId }: { store: Store; threadId: string; tabId?: string } = $props();
  let paused = $state(false), busy = $state(false), error = $state(''), text = $state('');
  let frame = $state.raw<RemoteBrowserFrame | null>(null), picture = $state<HTMLImageElement>();
  // Core timestamps use another device's clock. Retain local age for each frame,
  // including one held by an in-progress pointer gesture.
  const receivedAt = new WeakMap<RemoteBrowserFrame, number>();
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, requestedAt = 0;
  // What the next request asks for and when: see remote-browser-view.ts.
  let roundTrip = 0, unchanged = 0, failures = 0;
  let pointer: { x: number; y: number; lastX: number; lastY: number; moved: boolean; mouse: boolean; shift: boolean; from: { x: number; y: number } | null; frame: RemoteBrowserFrame; client: Store['client'] } | undefined;
  // A computer drives the page itself: keys, wheel, mouse selection and the clipboard, with no keys or text field below.
  const desk = hasKeyboard();
  let area = $state<HTMLElement>(), screen = $state<HTMLButtonElement>(), note = $state(''), noteTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTap = { at: 0, x: 0, y: 0, count: 0 };
  // Mouse and keyboard input, sent one at a time in the order it was made, without freezing the view between two.
  type Direct = Extract<RemoteBrowserInput, { kind: 'tap' | 'drag' | 'press' | 'text' | 'select-all' }>;
  let queue: { value: Direct; target?: RemoteBrowserFrame }[] = [], draining: Promise<void> | null = null;
  // Pixels dragged but not yet sent, and where the finger started on the page.
  let scrollX = 0, scrollY = 0, scrolling = false, scrollAt: { x: number; y: number } | null = null;
  let frameClient = $state.raw<Store['client']>(null);
  let displaySettings = $state(false), viewportWidth = $state<number | undefined>(393), viewportHeight = $state<number | undefined>(700);
  let areaWidth = $state(0), areaHeight = $state(0), zoom = $state(0);
  let address = $state(''), editingAddress = false, fresh = $state(true);
  const previewScale = $derived(frame ? (zoom || Math.min(areaWidth / frame.width, areaHeight / frame.height)) : 1);
  const validSize = $derived([viewportWidth, viewportHeight].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 240 && n <= 3840));
  const usable = $derived(!!frame && frameClient === store.client && !paused && !busy && !error && store.connection === 'ready');
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  function stop() { generation++; clearTimeout(timer); }
  async function decoded(base64: string): Promise<void> {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
  }
  async function poll(run: number): Promise<void> {
    if (!alive || run !== generation || paused || document.hidden) return;
    if (pending || busy) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client, started = performance.now();
    let retry = false;
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const maxWidth = frameMaxWidth(frame ? frame.width * previewScale : areaWidth, window.devicePixelRatio), quality = frameQuality(roundTrip);
      const next = await client.call('browser.remoteFrame', { threadId, ...(tabId ? { tabId } : {}), ...(maxWidth ? { maxWidth } : {}), ...(quality !== 55 ? { quality } : {}) });
      // Decoded off the main thread before it replaces the shown frame: a drag stays smooth and Safari never paints a half-loaded image.
      if (next.base64 !== frame?.base64) await decoded(next.base64);
      if (!alive || run !== generation) return;
      if (client === store.client) {
        roundTrip = performance.now() - started; failures = 0;
        unchanged = frame && next.base64 === frame.base64 && next.width === frame.width && next.height === frame.height ? unchanged + 1 : 0;
        receivedAt.set(next, performance.now()); frameClient = client; frame = next; error = ''; fresh = true;
        if (!editingAddress) address = next.url ?? '';
      }
      else { frame = null; frameClient = null; error = strings.remoteBrowser.reconnecting; }
    } catch (cause) {
      if (alive && run === generation) {
        const reason = message(cause);
        // The core spaces frame requests; a refusal for asking early is not a failure.
        if (/wait before requesting/.test(reason)) retry = true;
        else { failures++; error = reason; }
      }
    }
    finally { pending = false; }
    if (alive && run === generation) timer = setTimeout(() => void poll(run), retry ? 250 : nextPollDelay({ roundTrip, unchanged, failures }));
  }
  function resume() {
    stop();
    if (!paused && !document.hidden) {
      const run = generation;
      timer = setTimeout(() => void poll(run), Math.max(0, FRAME_INTERVAL - (Date.now() - requestedAt)));
    }
  }
  /** After an input the page moves: the next frame comes at full rate, without dropping one in flight. */
  function kick() {
    unchanged = 0;
    if (pending || paused || document.hidden) return;
    clearTimeout(timer);
    const run = generation;
    timer = setTimeout(() => void poll(run), Math.max(60, FRAME_INTERVAL - (Date.now() - requestedAt)));
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
    const ready = store.connection === 'ready';
    if (!paused) untrack(() => { if (ready) failures = 0; resume(); }); else untrack(stop);
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
      // Those retire the frame on the agent's machine: show it as stale until the next one.
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
  const old = (target: RemoteBrowserFrame) => performance.now() - (receivedAt.get(target) ?? -Infinity) > 5000;
  /** Keys typed while a request is in flight leave together in the next one. */
  function direct(value: Direct, target?: RemoteBrowserFrame) {
    const last = queue.at(-1)?.value;
    if (value.kind === 'press' && last?.kind === 'press' && last.keys.length + value.keys.length <= REMOTE_PRESS_MAX) last.keys.push(...value.keys);
    else queue.push({ value: value.kind === 'press' ? { kind: 'press', keys: [...value.keys] } : value, ...(target ? { target } : {}) });
    draining ??= drain().finally(() => { draining = null; });
  }
  async function drain(): Promise<void> {
    while (queue.length) {
      const { value, target = frame } = queue.shift()!, client = store.client;
      // What cannot land on the page the user saw is dropped, never replayed on another.
      if (!alive || !client || frameClient !== client || !target || paused || store.connection !== 'ready' || old(target)) { queue = []; return; }
      try { await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value }); }
      catch (cause) { queue = []; if (alive && client === store.client) error = message(cause); return; }
      finally { if (alive) kick(); }
    }
  }
  /** The page's selected text, once what was typed before the copy has reached it. */
  async function selection(): Promise<string> {
    await draining;
    const client = store.client, target = frame;
    if (!client || frameClient !== client || !target) return '';
    const { text, truncated } = await client.call('browser.remoteSelection', { threadId, frameId: target.id });
    if (truncated) say(strings.remoteBrowser.copyCut);
    return text;
  }
  function say(text: string) { note = text; clearTimeout(noteTimer); noteTimer = setTimeout(() => { note = ''; }, 3000); }
  /** The Copy button, for a screen with no Control+C. */
  async function copySelection() {
    try { say(await writeClipboardLater(selection()) ? strings.remoteBrowser.copied : strings.remoteBrowser.nothingSelected); }
    catch (cause) { say(message(cause)); }
  }
  onMount(() => {
    const live = liveInput(() => area, {
      key(event) {
        if (!frame || paused) return false;
        const sent = browserKey(event);
        if (!sent) return false;
        direct(sent === 'select-all' ? { kind: 'select-all' } : 'press' in sent ? { kind: 'press', keys: [sent.press] } : { kind: 'text', text: sent.text });
        return true;
      },
      paste(pasted) { for (let at = 0; at < pasted.length; at += REMOTE_TEXT_MAX) direct({ kind: 'text', text: pasted.slice(at, at + REMOTE_TEXT_MAX) }); },
      copy: selection,
      cut() { direct({ kind: 'press', keys: ['Backspace'] }); },
      failed(reason) { say(reason); },
    });
    return () => { live.destroy(); clearTimeout(noteTimer); };
  });
  // The wheel scrolls the page, not the panel: the listener must be able to cancel it.
  $effect(() => {
    const node = screen;
    if (!node) return;
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  });
  function wheel(event: WheelEvent) {
    if (zoom || event.ctrlKey || !usable || !frame) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? frame.height : 1;
    scrollAt = point(event, frame);
    scrollX -= event.deltaX * unit; scrollY -= event.deltaY * unit;
    flushScroll();
  }
  function resize(width: number, height: number) {
    viewportWidth = Math.max(240, Math.min(3840, Math.round(width)));
    viewportHeight = Math.max(240, Math.min(3840, Math.round(height)));
    zoom = 0;
    void input({ kind: 'viewport', width: viewportWidth, height: viewportHeight });
  }
  function point(event: MouseEvent, current: RemoteBrowserFrame) {
    return picture ? framePoint(picture.getBoundingClientRect(), current, event.clientX, event.clientY) : null;
  }
  /** As `point`, for a drag released outside the picture: it ends on the nearest edge. */
  function edgePoint(event: MouseEvent, current: RemoteBrowserFrame) {
    if (!picture) return null;
    const box = picture.getBoundingClientRect(), within = (n: number, low: number, size: number) => Math.max(low, Math.min(low + size, n));
    return framePoint(box, current, within(event.clientX, box.left, box.width), within(event.clientY, box.top, box.height));
  }
  function down(event: PointerEvent) {
    if (!usable || !frame || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, moved: false, mouse: event.pointerType === 'mouse', shift: event.shiftKey, from: point(event, frame), frame, client: frameClient };
    scrollX = 0; scrollY = 0; scrollAt = point(event, frame);
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture?.(event.pointerId);
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
    if (start.mouse) return; // A mouse drag selects on release; its wheel scrolls.
    scrollX += event.clientX - start.lastX; scrollY += event.clientY - start.lastY;
    start.lastX = event.clientX; start.lastY = event.clientY;
    flushScroll();
  }
  function up(event: PointerEvent) {
    const start = pointer; pointer = undefined;
    if (!start || start.client !== store.client) return;
    const size = { width: start.frame.width, height: start.frame.height };
    if (start.mouse && (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8)) {
      const to = edgePoint(event, start.frame);
      if (start.from && to) direct({ kind: 'drag', from: start.from, to, ...size }, start.frame);
      return;
    }
    if (start.moved || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8) {
      if (zoom) return; // Enlarged previews pan locally; arrow buttons scroll the shared page.
      scrollX += event.clientX - start.lastX; scrollY += event.clientY - start.lastY;
      flushScroll();
    } else {
      const p = point(event, start.frame);
      if (!p) return;
      // A second and a third click at the same place select the word, then the paragraph.
      const again = performance.now() - lastTap.at < 450 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) <= 6;
      const count = (again ? Math.min(3, lastTap.count + 1) : 1) as 1 | 2 | 3;
      lastTap = { at: performance.now(), x: event.clientX, y: event.clientY, count };
      const tap = { kind: 'tap' as const, ...p, ...size, ...(count > 1 ? { count } : {}), ...(start.shift ? { shift: true } : {}) };
      if (start.mouse) direct(tap, start.frame); else void input(tap, start.frame);
    }
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

<section class="remote" data-testid="remote-browser" aria-label={strings.remoteBrowser.title}>
  <form class="nav" data-testid="remote-browser-nav" onsubmit={go}>
    <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.back} onclick={() => void input({ kind: 'history', direction: 'back' })}><ArrowLeft size={17} /></button>
    <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.forward} onclick={() => void input({ kind: 'history', direction: 'forward' })}><ArrowRight size={17} /></button>
    <button type="button" class="chip" disabled={!usable} aria-label={strings.remoteBrowser.reload} onclick={() => void input({ kind: 'reload' })}><RotateCw size={16} /></button>
    <input bind:value={address} data-testid="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.address} onfocus={e => { editingAddress = true; e.currentTarget.select(); }} onblur={() => { editingAddress = false; }} />
    <button type="submit" class="chip go" disabled={!usable || !address.trim()}><span class="ui-label">{strings.remoteBrowser.go}</span></button>
  </form>
  <div class="toolbar"><span class="state ui-label" data-testid="remote-browser-state" class:live={frame && !paused && !error}>{paused ? strings.remoteBrowser.paused : error ? strings.remoteBrowser.reconnecting : frame ? strings.remoteBrowser.live : strings.remoteBrowser.waiting}</span>
    <button type="button" class="chip" data-testid="remote-browser-display" aria-expanded={displaySettings} onclick={() => { displaySettings = !displaySettings; if (frame) { viewportWidth = frame.width; viewportHeight = frame.height; } }}><span class="ui-label">{strings.remoteBrowser.display}</span></button>
    <button type="button" class="chip" onclick={() => { paused = !paused; }}>{#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}<span class="ui-label">{paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause}</span></button></div>
  {#if error}<div class="error" role="status" data-testid="remote-browser-error"><p>{error}</p></div>{/if}
  <div class="viewer">
  {#if displaySettings}
    <section class="display-settings" aria-label={strings.remoteBrowser.display}>
      <strong>{strings.remoteBrowser.resolution} {frame ? `${frame.width} × ${frame.height}` : ''}</strong>
      <div class="options">
        <button class="chip" disabled={!usable} onclick={() => resize(areaWidth, areaHeight)}><span class="ui-label">{strings.remoteBrowser.fitPhone}</span></button>
        <button class="chip" disabled={!usable} onclick={() => resize(393, 700)}><span class="ui-label">{strings.remoteBrowser.phone}</span></button>
        <button class="chip" disabled={!usable} onclick={() => resize(768, 1024)}><span class="ui-label">{strings.remoteBrowser.tablet}</span></button>
        <button class="chip" disabled={!usable} onclick={() => resize(1366, 768)}><span class="ui-label">PC</span></button>
        <button class="chip" disabled={!usable || !frame} onclick={() => frame && resize(frame.height, frame.width)}><span class="ui-label">{strings.remoteBrowser.rotate}</span></button>
      </div>
      <form onsubmit={e => { e.preventDefault(); if (validSize) resize(viewportWidth!, viewportHeight!); }}>
        <label>{strings.remoteBrowser.width}<input type="number" min="240" max="3840" step="1" required bind:value={viewportWidth} /></label>
        <label>{strings.remoteBrowser.height}<input type="number" min="240" max="3840" step="1" required bind:value={viewportHeight} /></label>
        <button class="chip" type="submit" disabled={!usable || !validSize}><span class="ui-label">{strings.remoteBrowser.apply}</span></button>
      </form>
      <small>{strings.remoteBrowser.sharedSize}</small>
      <button class="chip" disabled={!usable} onclick={() => void input({ kind: 'reset-viewport' })}><span class="ui-label">{strings.remoteBrowser.restoreSize}</span></button>
      <strong>{strings.remoteBrowser.previewZoom}</strong>
      <div class="options">
        <button class="chip" aria-pressed={zoom === 0} onclick={() => { zoom = 0; displaySettings = false; }}><span class="ui-label">{strings.remoteBrowser.fit}</span></button>
        {#each [1, 1.5, 2] as scale}<button class="chip" aria-pressed={zoom === scale} onclick={() => { zoom = scale; displaySettings = false; }}><span class="ui-label">{scale * 100}%</span></button>{/each}
      </div>
    </section>
  {/if}
  <div class="screen-area" class:zoomed={zoom > 0} bind:this={area} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
    {#if frame}
      <button bind:this={screen} type="button" class="screen" style:width={`${frame.width * previewScale}px`} style:height={`${frame.height * previewScale}px`} class:stale={paused || error || !fresh} class:desk aria-label={desk ? strings.remoteBrowser.interactDesk : strings.remoteBrowser.interact} disabled={!usable} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => { pointer = undefined; }} oncontextmenu={e => e.preventDefault()}>
        <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={strings.remoteBrowser.image} draggable="false" data-testid="remote-browser-frame" />
      </button>
    {:else}<p class="empty">{strings.remoteBrowser.waiting}</p>{/if}
  </div>
  </div>
  {#if desk}
  <footer class="desk"><small class="note" role="status" data-testid="remote-browser-note">{note || (zoom ? strings.remoteBrowser.panHint : strings.remoteBrowser.deskHint)}</small></footer>
  {:else}
  <footer>
    <div class="keys"><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: -500 })} aria-label={strings.remoteBrowser.scrollUp}><ArrowUp size={17} /></button><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: 500 })} aria-label={strings.remoteBrowser.scrollDown}><ArrowDown size={17} /></button>
      {#each (['Tab', 'Enter', 'Escape', 'Backspace'] as const) as key}<button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'key', key })}><span class="ui-label">{key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}</span></button>{/each}
      <button type="button" class="chip" data-testid="remote-browser-copy" disabled={!usable} aria-label={strings.remoteBrowser.copy} title={strings.remoteBrowser.copy} onclick={() => void copySelection()}><Copy size={16} /></button>
    </div>
    <form onsubmit={e => { e.preventDefault(); void sendText(false); }}><input bind:value={text} data-testid="remote-browser-text" maxlength="2000" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={strings.remoteBrowser.text} placeholder={strings.remoteBrowser.text} onkeydown={textKey} /><button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.remoteBrowser.send}><Send size={17} /></button></form>
    {#if note}<small class="note" role="status" data-testid="remote-browser-note">{note}</small>{/if}
    <small>{zoom ? strings.remoteBrowser.panHint : strings.remoteBrowser.gesture}</small>
  </footer>
  {/if}
</section>

<style>
  .remote { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
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
  .error { display: flex; align-items: center; gap: 8px; padding: 0 16px 8px; } .error p { flex: 1; margin: 0; font-size: var(--text-sm); color: var(--color-danger); max-height: 90px; overflow: auto; overflow-wrap: anywhere; } .empty { margin: auto; padding: 24px; }
  .screen.desk { cursor: default; } footer.desk { padding-block: 6px max(8px, env(safe-area-inset-bottom)); }
  @media (max-width: 720px) { footer small { display: none; } footer small.note { display: block; } .nav, .toolbar, footer { padding-inline: 12px; } .nav { gap: 4px; } }
</style>
