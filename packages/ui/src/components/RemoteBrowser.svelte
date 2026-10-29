<script lang="ts">
  import { errorText } from '../lib/errors';
  import { onMount, untrack } from 'svelte';
  import { Pause, Play, ArrowUp, ArrowDown, Copy, MonitorSmartphone, Send } from '@lucide/svelte';
  import { REMOTE_PRESS_MAX, REMOTE_TEXT_MAX, type RemoteBrowserFrame, type RemoteBrowserInput, type RemoteBrowserPicker } from '@boite/contracts';
  import { browserKey, hasKeyboard, liveInput, writeClipboardLater } from '../lib/live-input';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import BrowserNav from './BrowserNav.svelte';
  import { normalizeUrl } from '../lib/browser-bridge';
  import { policySearch } from '../lib/policy';
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
  /**
   * The `<select>` a tap opened. Chrome draws its list in a window of its own on
   * the agent's machine, which no frame shows: the list is drawn here, and a
   * choice goes back as `choose` at the tap's point.
   */
  type Tapped = Extract<RemoteBrowserInput, { kind: 'tap' }>;
  let choice = $state.raw<{ picker: RemoteBrowserPicker; tap: Tapped; place: { left: number; width: number; top?: number; bottom?: number; maxHeight: number } } | null>(null);
  let active = $state(-1), viewer = $state<HTMLElement>(), pickerList = $state<HTMLElement>();
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
  const addressId = `remote-address-${crypto.randomUUID()}`, hintId = `${addressId}-hint`, pickerId = `${addressId}-picker`;
  const secure = $derived(/^https:\/\//i.test(frame?.url ?? ''));
  const previewScale = $derived(frame ? (zoom || Math.min(areaWidth / frame.width, areaHeight / frame.height)) : 1);
  const validSize = $derived([viewportWidth, viewportHeight].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 240 && n <= 3840));
  const usable = $derived(!!frame && frameClient === store.client && !paused && !busy && !error && store.connection === 'ready');
  function stop() { generation++; clearTimeout(timer); }
  // A list stays with the page it was tapped on.
  $effect(() => { if (choice && (!frame || frame.width !== choice.tap.width || frame.height !== choice.tap.height || paused)) choice = null; });
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
      // The frame shown: the core answers with a newer one, or that the page drew nothing new within a second.
      const after = frame && frameClient === client ? frame.id : undefined;
      const next = await client.call('browser.remoteFrame', { threadId, ...(tabId ? { tabId } : {}), ...(maxWidth ? { maxWidth } : {}), ...(quality !== 55 ? { quality } : {}), ...(after ? { after } : {}) });
      const changed = 'unchanged' in next ? null : next;
      // Decoded off the main thread before it replaces the shown frame: a drag stays smooth and Safari never paints a half-loaded image.
      if (changed && changed.base64 !== frame?.base64) await decoded(changed.base64);
      if (!alive || run !== generation) return;
      if (client !== store.client) { frame = null; frameClient = null; error = strings.remoteBrowser.reconnecting; }
      else {
        // The core's wait for the page is not the link's.
        roundTrip = Math.max(0, performance.now() - started - (next.waitedMs ?? 0)); failures = 0;
        if (!changed) {
          // The frame shown is still the page, and input aimed at it is still valid.
          if (frame && next.id === frame.id) { unchanged++; receivedAt.set(frame, performance.now()); error = ''; fresh = true; }
        } else {
          // A core from before `after` sends every frame again: identical ones count as unchanged.
          unchanged = frame && changed.base64 === frame.base64 && changed.width === frame.width && changed.height === frame.height ? unchanged + 1 : 0;
          receivedAt.set(changed, performance.now()); frameClient = client; frame = changed; error = ''; fresh = true;
          if (!editingAddress) address = changed.url ?? '';
        }
      }
    } catch (cause) {
      if (alive && run === generation) {
        const reason = errorText(cause);
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
      const reply = await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value });
      if (alive && run === generation && client === store.client && value.kind === 'text') text = '';
      if (alive && run === generation && client === store.client && value.kind === 'tap' && reply?.picker) open(reply.picker, value);
      // Those retire the frame on the agent's machine: show it as stale until the next one.
      if (moving) fresh = false;
      return true;
    }
    catch (cause) { if (alive && run === generation && client === store.client) error = errorText(cause); return false; }
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
      try {
        const reply = await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value });
        if (alive && client === store.client && value.kind === 'tap' && reply?.picker) open(reply.picker, value);
      }
      catch (cause) { queue = []; if (alive && client === store.client) error = errorText(cause); return; }
      finally { if (alive) kick(); }
    }
  }
  /** Draws the tapped list under its field, or over it when the view has more room there. */
  function open(picker: RemoteBrowserPicker, tap: Tapped) {
    const box = picture?.getBoundingClientRect(), frameBox = viewer?.getBoundingClientRect();
    if (!box || !frameBox || !picker.options.some(option => !option.hidden)) return;
    const left = box.left - frameBox.left + picker.rect.x * box.width, top = box.top - frameBox.top + picker.rect.y * box.height;
    const width = Math.min(frameBox.width - 8, Math.max(160, picker.rect.width * box.width)), field = picker.rect.height * box.height;
    const below = frameBox.height - top - field - 4, above = top - 4;
    const room = below >= Math.min(240, above) ? { top: top + field + 2, maxHeight: Math.min(320, below - 4) } : { bottom: frameBox.height - top + 2, maxHeight: Math.min(320, above - 4) };
    choice = { picker, tap, place: { left: Math.max(4, Math.min(left, frameBox.width - width - 4)), width, ...room } };
    active = picker.selected;
    requestAnimationFrame(() => pickerList?.querySelector('[aria-selected=true]')?.scrollIntoView?.({ block: 'nearest' }));
  }
  function choose(index: number) {
    const shown = choice, target = frame;
    choice = null;
    const option = shown?.picker.options[index];
    // The list belongs to the page it was tapped on: a resized page drops it.
    if (!shown || !option || option.disabled || option.hidden || !target || target.width !== shown.tap.width || target.height !== shown.tap.height) return;
    if (index !== shown.picker.selected) void input({ kind: 'choose', x: shown.tap.x, y: shown.tap.y, width: shown.tap.width, height: shown.tap.height, index, label: option.label });
  }
  /** The keys a list takes while it is open: the arrows, Home, End, Enter, Space and Escape. */
  function pickerKey(event: KeyboardEvent): boolean {
    if (!choice) return false;
    const options = choice.picker.options, usable = (i: number) => !!options[i] && !options[i]!.disabled && !options[i]!.hidden;
    const step = (from: number, by: number) => { for (let i = from + by; i >= 0 && i < options.length; i += by) if (usable(i)) return i; return from; };
    if (event.key === 'Escape') choice = null;
    else if (event.key === 'Enter' || event.key === ' ') choose(active);
    else if (event.key === 'ArrowDown') active = step(active, 1);
    else if (event.key === 'ArrowUp') active = step(active, -1);
    else if (event.key === 'Home') active = step(-1, 1);
    else if (event.key === 'End') active = step(options.length, -1);
    else return false;
    requestAnimationFrame(() => document.getElementById(`${pickerId}-${active}`)?.scrollIntoView?.({ block: 'nearest' }));
    return true;
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
    catch (cause) { say(errorText(cause)); }
  }
  onMount(() => {
    const live = liveInput(() => area, {
      key(event) {
        if (choice) return pickerKey(event);
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
    choice = null;
    if (zoom || event.ctrlKey || !usable || !frame) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? frame.height : 1;
    scrollAt = point(event, frame);
    scrollX -= event.deltaX * unit; scrollY -= event.deltaY * unit;
    flushScroll();
  }
  /**
   * The page takes the size of this view by default, as a browser's page takes
   * its window's: on Show and whenever the view changes size, once it settles.
   * Once per size of this view: a preset the agent applies, or another
   * viewer's fit, stands until this view itself changes size. A size picked by
   * hand in Display stops that until Fit this screen.
   */
  let fitted = $state(true), fittedTo = '', fitTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = $derived(usable);
  $effect(() => {
    const width = Math.round(areaWidth), height = Math.round(areaHeight);
    if (!fitted || !ready || zoom || width < 240 || height < 240) return;
    const size = `${width}x${height}`;
    if (size === fittedTo) return;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => untrack(() => {
      if (!fitted || !frame) return;
      fittedTo = size;
      if (Math.abs(frame.width - width) <= 2 && Math.abs(frame.height - height) <= 2) return;
      void input({ kind: 'viewport', width: Math.min(3840, width), height: Math.min(3840, height) });
    }), 350);
    return () => clearTimeout(fitTimer);
  });
  function resize(width: number, height: number, fit = false) {
    fitted = fit;
    fittedTo = fit ? `${Math.round(width)}x${Math.round(height)}` : '';
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
    choice = null;
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
    const url = normalizeUrl(address, policySearch(store.policy));
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
  <BrowserNav {addressId} {secure} loading={!!frame && !fresh && !paused} spinning={!!frame && !fresh} disabled={!usable} onsubmit={go}
    onback={() => void input({ kind: 'history', direction: 'back' })} onforward={() => void input({ kind: 'history', direction: 'forward' })} onreload={() => void input({ kind: 'reload' })}>
    {#snippet field()}
      <input id={addressId} bind:value={address} data-testid="remote-browser-address" type="text" inputmode="url" enterkeyhint="go" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="4096" aria-label={strings.remoteBrowser.address} placeholder={strings.remoteBrowser.addressPlaceholder} onfocus={e => { editingAddress = true; e.currentTarget.select(); }} onblur={() => { editingAddress = false; }} />
    {/snippet}
    {#snippet status()}
      {#if paused || error || !frame}<span class="state ui-label" data-testid="remote-browser-state">{paused ? strings.remoteBrowser.paused : error ? strings.remoteBrowser.reconnecting : strings.remoteBrowser.waiting}</span>{/if}
    {/snippet}
    {#snippet actions()}
      <button type="button" class="ghost small icon" data-testid="remote-browser-display" aria-expanded={displaySettings} title={strings.remoteBrowser.display} aria-label={strings.remoteBrowser.display} onclick={() => { displaySettings = !displaySettings; if (frame) { viewportWidth = frame.width; viewportHeight = frame.height; } }}><MonitorSmartphone size={15} strokeWidth={1.75} /></button>
      <button type="button" class="ghost small icon toggle" data-testid="remote-browser-pause" aria-pressed={paused} title={paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause} aria-label={paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause} onclick={() => { paused = !paused; }}>{#if paused}<Play size={14} strokeWidth={1.75} />{:else}<Pause size={14} strokeWidth={1.75} />{/if}</button>
    {/snippet}
  </BrowserNav>
  {#if error}<div class="error" role="status" data-testid="remote-browser-error"><p>{error}</p></div>{/if}
  <div class="viewer" bind:this={viewer}>
  {#if displaySettings}
    <section class="display-settings" aria-label={strings.remoteBrowser.display}>
      <strong>{strings.remoteBrowser.resolution} {frame ? `${frame.width} × ${frame.height}` : ''}</strong>
      <div class="options">
        <button class="small" disabled={!usable} aria-pressed={fitted} onclick={() => resize(areaWidth, areaHeight, true)}><span class="ui-label">{strings.remoteBrowser.fitPhone}</span></button>
        <button class="small" disabled={!usable} onclick={() => resize(393, 700)}><span class="ui-label">{strings.remoteBrowser.phone}</span></button>
        <button class="small" disabled={!usable} onclick={() => resize(768, 1024)}><span class="ui-label">{strings.remoteBrowser.tablet}</span></button>
        <button class="small" disabled={!usable} onclick={() => resize(1366, 768)}><span class="ui-label">PC</span></button>
        <button class="small" disabled={!usable || !frame} onclick={() => frame && resize(frame.height, frame.width)}><span class="ui-label">{strings.remoteBrowser.rotate}</span></button>
      </div>
      <form onsubmit={e => { e.preventDefault(); if (validSize) resize(viewportWidth!, viewportHeight!); }}>
        <label>{strings.remoteBrowser.width}<input type="number" min="240" max="3840" step="1" required bind:value={viewportWidth} /></label>
        <label>{strings.remoteBrowser.height}<input type="number" min="240" max="3840" step="1" required bind:value={viewportHeight} /></label>
        <button class="small" type="submit" disabled={!usable || !validSize}><span class="ui-label">{strings.remoteBrowser.apply}</span></button>
      </form>
      <small>{strings.remoteBrowser.sharedSize}</small>
      <button class="small ghost restore" disabled={!usable} onclick={() => { fitted = false; void input({ kind: 'reset-viewport' }); }}><span class="ui-label">{strings.remoteBrowser.restoreSize}</span></button>
      <strong>{strings.remoteBrowser.previewZoom}</strong>
      <div class="options">
        <button class="small" aria-pressed={zoom === 0} onclick={() => { zoom = 0; displaySettings = false; }}><span class="ui-label">{strings.remoteBrowser.fit}</span></button>
        {#each [1, 1.5, 2] as scale}<button class="small" aria-pressed={zoom === scale} onclick={() => { zoom = scale; displaySettings = false; }}><span class="ui-label">{scale * 100}%</span></button>{/each}
      </div>
    </section>
  {/if}
  <div class="screen-area" class:zoomed={zoom > 0} title={desk && frame ? strings.remoteBrowser.deskHint : undefined} bind:this={area} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
    {#if frame}
      <button bind:this={screen} type="button" class="screen" style:width={`${frame.width * previewScale}px`} style:height={`${frame.height * previewScale}px`} class:stale={paused || error} class:desk aria-label={desk ? strings.remoteBrowser.interactDesk : strings.remoteBrowser.interact} aria-describedby={desk ? hintId : undefined} disabled={!usable} onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={() => { pointer = undefined; }} oncontextmenu={e => e.preventDefault()}>
        <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={strings.remoteBrowser.image} draggable="false" data-testid="remote-browser-frame" />
      </button>
    {:else}<p class="empty">{strings.remoteBrowser.waiting}</p>{/if}
    {#if choice}
      {@const place = choice.place}
      {@const options = choice.picker.options}
      <div class="picker" role="listbox" tabindex="-1" bind:this={pickerList} data-testid="remote-browser-picker" aria-label={strings.remoteBrowser.options} aria-activedescendant={active >= 0 ? `${pickerId}-${active}` : undefined}
        style:left={`${place.left}px`} style:width={`${place.width}px`} style:top={place.top === undefined ? undefined : `${place.top}px`} style:bottom={place.bottom === undefined ? undefined : `${place.bottom}px`} style:max-height={`${Math.max(80, place.maxHeight)}px`}>
        {#each options as option, index}
          {#if !option.hidden}
            {#if option.group && option.group !== options.slice(0, index).findLast(other => !other.hidden)?.group}<span class="group ui-label">{option.group}</span>{/if}
            <button type="button" role="option" tabindex="-1" id={`${pickerId}-${index}`} class:active={index === active} class:grouped={!!option.group} aria-selected={index === choice.picker.selected} disabled={option.disabled} onpointerenter={() => { if (!option.disabled) active = index; }} onclick={() => choose(index)}>{option.label || '\u00a0'}</button>
          {/if}
        {/each}
      </div>
    {/if}
    {#if desk}<span id={hintId} class="visually-hidden">{strings.remoteBrowser.deskHint}</span>{/if}
  </div>
  {#if desk && note}<small class="toast" role="status" data-testid="remote-browser-note">{note}</small>{/if}
  </div>
  {#if !desk}
  <footer>
    <div class="keys"><button type="button" class="ghost small icon" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: -500 })} aria-label={strings.remoteBrowser.scrollUp}><ArrowUp size={16} /></button><button type="button" class="ghost small icon" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: 500 })} aria-label={strings.remoteBrowser.scrollDown}><ArrowDown size={16} /></button>
      {#each (['Tab', 'Enter', 'Escape', 'Backspace'] as const) as key}<button type="button" class="ghost small" disabled={!usable} onclick={() => void input({ kind: 'key', key })}><span class="ui-label">{key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}</span></button>{/each}
      <button type="button" class="ghost small icon" data-testid="remote-browser-copy" disabled={!usable} aria-label={strings.remoteBrowser.copy} title={strings.remoteBrowser.copy} onclick={() => void copySelection()}><Copy size={15} /></button>
    </div>
    <form onsubmit={e => { e.preventDefault(); void sendText(false); }}><input bind:value={text} data-testid="remote-browser-text" maxlength="2000" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={strings.remoteBrowser.text} placeholder={strings.remoteBrowser.text} onkeydown={textKey} /><button type="submit" class="ghost small icon" disabled={!usable || !text} aria-label={strings.remoteBrowser.send}><Send size={16} /></button></form>
    {#if note}<small class="note" role="status" data-testid="remote-browser-note">{note}</small>{/if}
    <small class="hint">{zoom ? strings.remoteBrowser.panHint : strings.remoteBrowser.gesture}</small>
  </footer>
  {/if}
</section>

<style>
  .remote { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; position: relative; overflow-x: clip; }
  small, .empty { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .state { flex: none; margin-left: 6px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .toggle[aria-pressed=true] { color: var(--color-accent); background: var(--color-accent-soft); }
  .viewer { position: relative; flex: 1; min-height: 80px; overflow: hidden; }
  .screen-area { width: 100%; height: 100%; display: flex; background: var(--color-background); overflow: auto; }
  .zoomed .screen { touch-action: pan-x pan-y; }
  .display-settings { position: absolute; z-index: 3; top: 6px; right: 8px; width: min(320px, calc(100% - 16px)); max-height: calc(100% - 12px); overflow: auto; padding: 12px; display: grid; gap: 8px; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-e3); }
  .display-settings strong { font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .options { display: flex; flex-wrap: wrap; gap: 4px; }
  .display-settings label { flex: 1; min-width: 0; display: grid; gap: 2px; font-size: var(--text-xs); color: var(--color-muted-foreground); }
  .display-settings input { width: 100%; height: var(--control-sm); font-size: var(--text-sm); }
  .display-settings form { display: flex; gap: 6px; align-items: flex-end; }
  .display-settings .restore { justify-self: start; }
  .options [aria-pressed=true] { color: var(--color-accent); border-color: var(--color-accent); background: var(--color-accent-soft); }
  .screen { flex: none; margin: 0 auto auto; padding: 0; border: 0; border-radius: 0; background: transparent; box-shadow: none; touch-action: none; cursor: default; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .screen:hover:not(:disabled) { background: transparent; }
  .screen:active:not(:disabled) { transform: none; }
  .screen:disabled { opacity: 1; } .screen.stale { opacity: .55; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; -webkit-user-select: none; user-select: none; }
  .picker { position: absolute; z-index: 4; overflow: auto; padding: 4px; display: flex; flex-direction: column; background: var(--color-surface-2); border: 1px solid var(--color-border); border-radius: var(--radius-lg); box-shadow: var(--shadow-e3); overscroll-behavior: contain; }
  .picker button { flex: none; justify-content: flex-start; min-height: var(--control-sm); padding: 4px 10px; border: 0; border-radius: var(--radius-sm); background: transparent; box-shadow: none; color: var(--color-foreground); font-size: var(--text-sm); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .picker button.grouped { padding-left: 20px; }
  .picker button.active:not(:disabled) { background: var(--color-surface-3); }
  .picker button[aria-selected=true] { color: var(--color-accent); background: var(--color-accent-soft); }
  .picker button:disabled { color: var(--color-muted-foreground); opacity: .6; }
  .picker .group { padding: 6px 10px 2px; font-size: var(--text-xs); font-weight: 600; color: var(--color-muted-foreground); }
  .toast { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); max-width: calc(100% - 24px); padding: 6px 12px; border-radius: var(--radius-full); background: var(--color-surface-3); color: var(--color-foreground); box-shadow: var(--shadow-e2); font-size: var(--text-xs); pointer-events: none; }
  footer { padding: 6px 8px max(8px, env(safe-area-inset-bottom)); display: grid; gap: 6px; border-top: 1px solid var(--color-border); background: var(--color-surface); }
  .keys { display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; }
  .keys::-webkit-scrollbar { display: none; }
  .keys button { flex: none; }
  footer form { display: flex; gap: 4px; align-items: center; margin: 0; }
  footer input { min-width: 0; flex: 1; height: var(--control); border-radius: var(--radius-full); padding: 0 12px; font-size: var(--text-md); }
  .error { padding: 6px 12px; border-bottom: 1px solid var(--color-border); } .error p { margin: 0; font-size: var(--text-sm); color: var(--color-danger); max-height: 90px; overflow: auto; overflow-wrap: anywhere; }
  .empty { margin: auto; padding: 24px; }
  @media (max-width: 720px), (pointer: coarse) { .display-settings input { font-size: var(--text-md); } .picker button { min-height: var(--control); font-size: var(--text-md); } }
  @media (max-width: 720px) { footer .hint { display: none; } }
</style>
