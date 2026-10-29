<script lang="ts">
  import { errorText } from '../lib/errors';
  import { onMount, untrack } from 'svelte';
  import { Camera, Circle, Copy, CornerDownLeft, Delete, EyeOff, Pause, Play, Plus, Power, RefreshCw, RotateCw, Send, Smartphone, Square, Triangle, X } from '@lucide/svelte';
  import { isAdbText, MOBILE_CLIPBOARD_MAX, MOBILE_SCROLL_MAX, MOBILE_TEXT_MAX, type MobileDevice, type MobileDeviceFrame, type MobileDeviceInput, type MobileDeviceList, type MobileDeviceSession } from '@boite/contracts';
  import { deviceKey, devicePaste, hasKeyboard, liveInput, writeClipboardLater } from '../lib/live-input';
  import { canDecode, playDeviceStream, streamSize, type StreamFallback, type StreamPicture } from '../lib/device-stream';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { FRAME_INTERVAL, frameMaxWidth, framePoint, frameQuality, nextPollDelay } from '../lib/remote-browser-view';
  import { liveViews, machineName } from '../lib/live-view.svelte';
  import { SnapshotFeed } from '../lib/snapshot-feed';
  /**
   * The simulators and emulators open in this conversation, live (docs/devices.md).
   * The core captures their screen; this polls JPEG frames the way the phone's
   * browser view does, so it works the same on the desktop and on a paired phone.
   * No frame is asked for until the user shows the device: a card covers it
   * and names the machine it runs on. With the `deviceStream` setting on, an
   * Android device plays as live video instead (lib/device-stream.ts), and
   * touches, the wheel, any text and the clipboard go through its stream.
   */
  let { store, threadId }: { store: Store; threadId: string } = $props();
  let sessions = $state.raw<MobileDeviceSession[]>([]), selected = $state<string | null>(null);
  let list = $state.raw<MobileDeviceList | null>(null), picking = $state(false), loading = $state(false);
  let frame = $state.raw<MobileDeviceFrame | null>(null), picture = $state<HTMLImageElement>();
  let paused = $state(false), busy = $state(false), error = $state(''), text = $state(''), areaWidth = $state(0);
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, pending = false, requestedAt = 0;
  // `pictureTrip` sets the JPEG quality and counts only answers that carried one: a quick `unchanged`
  // must not change the quality, which would change the frame the core makes and its id.
  let roundTrip = 0, pictureTrip = 0, unchanged = 0, failures = 0;
  let pointer: { x: number; y: number; at: number; frame: MobileDeviceFrame } | undefined;
  // A computer types, pastes and scrolls on the screen itself; the text field below is the phone's.
  const desk = hasKeyboard();
  let viewer = $state<HTMLElement>(), screen = $state<HTMLButtonElement>();
  // Keyboard, wheel and stream touch input, sent one at a time in order: without the stream, each is an adb process on the agent's machine.
  // Each input keeps the connection and device it was made on, so one still queued when the tab changes never reaches another device.
  type InputTarget = { client: NonNullable<Store['client']>; deviceId: string };
  let typed: { to: InputTarget; input: MobileDeviceInput }[] = [], typing: Promise<void> | null = null;
  let wheelY = 0, wheelAt: { x: number; y: number; to: InputTarget } | null = null, wheelTimer: ReturnType<typeof setTimeout> | undefined;
  // The live stream: its picture while the canvas plays it, why the panel shows screenshots instead, and the fingers down on it.
  let canvas = $state<HTMLCanvasElement>(), stream = $state.raw<StreamPicture | null>(null), streamNote = $state(''), notice = $state(''), areaHeight = $state(0), pageHidden = $state(document.hidden);
  const fingers = new Map<number, number>();
  let notches = { x: 0, y: 0 }, notchAt: { x: number; y: number; to: InputTarget } | null = null, notchTimer: ReturnType<typeof setTimeout> | undefined, noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const session = $derived(sessions.find(one => one.deviceId === selected) ?? sessions[0] ?? null);
  const key = $derived(store.threadKey(threadId));
  const revealed = $derived(liveViews.shown('device', key));
  const machine = $derived(machineName(store));
  const showing = $derived(session?.state === 'ready' && revealed ? session : null);
  const live = $derived(!!stream && !!showing);
  const streamDevice = $derived(showing?.platform === 'android' ? showing.deviceId : null);
  const usable = $derived(!!showing && (live || (!!frame && frame.deviceId === showing.deviceId)) && !paused && !busy && store.connection === 'ready');

  function stop() { generation++; clearTimeout(timer); }
  async function decoded(base64: string): Promise<void> {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
  }
  async function poll(run: number): Promise<void> {
    const target = showing;
    // While the live stream plays, no screenshots: its fallback starts them again.
    if (!alive || run !== generation || paused || document.hidden || !target || stream) return;
    if (pending || busy) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client, started = performance.now();
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const maxWidth = frameMaxWidth(areaWidth, window.devicePixelRatio), quality = frameQuality(pictureTrip);
      // The core answers `unchanged`, with no picture, while the screen still shows the frame named here.
      const previous = frame?.deviceId === target.deviceId ? frame.id : undefined;
      const next = await client.call('devices.frame', { threadId, deviceId: target.deviceId, ...(maxWidth ? { maxWidth } : {}), quality, ...(previous ? { previous } : {}) });
      const same = next.unchanged ? !!frame && next.id === frame.id : next.base64 === frame?.base64;
      if (!same && !next.unchanged) await decoded(next.base64);
      if (!alive || run !== generation) return;
      roundTrip = performance.now() - started; failures = 0;
      if (!next.unchanged) pictureTrip = roundTrip;
      unchanged = same ? unchanged + 1 : 0;
      if (!next.unchanged) frame = next;
      error = '';
    } catch (cause) {
      if (alive && run === generation) { failures++; error = errorText(cause); }
    } finally { pending = false; }
    if (alive && run === generation) timer = setTimeout(() => void poll(run), nextPollDelay({ roundTrip, unchanged, failures }));
  }
  function resume() {
    stop();
    if (!paused && !document.hidden && showing) {
      const run = generation;
      timer = setTimeout(() => void poll(run), Math.max(0, FRAME_INTERVAL - (Date.now() - requestedAt)));
    }
  }
  /** After an input the screen moves: the next frame comes at full rate. */
  function kick() {
    unchanged = 0;
    if (pending || paused || document.hidden) return;
    clearTimeout(timer);
    const run = generation;
    timer = setTimeout(() => void poll(run), Math.max(60, FRAME_INTERVAL - (Date.now() - requestedAt)));
  }

  // The thread's sessions: read whole, kept by `devices.changed`; a change that lands while a read is out is applied after it.
  let feed: SnapshotFeed<MobileDeviceSession[]> | null = null;
  $effect(() => {
    const client = store.client;
    if (!client) return;
    const changes = feed = new SnapshotFeed<MobileDeviceSession[]>(next => {
      const known = new Set(sessions.map(one => one.deviceId));
      sessions = next;
      // A device just opened, by the agent or here, comes to the front.
      const added = next.find(one => !known.has(one.deviceId));
      if (added) { selected = added.deviceId; picking = false; }
      if (next.length === 0) void refresh();
    });
    const off = client.on('devices.changed', event => { if (event.threadId === threadId) changes.push(event.sessions); });
    untrack(() => void changes.read(() => client.call('devices.sessions', { threadId }), result => {
      sessions = result.sessions;
      if (result.sessions.length === 0) void refresh();
    }).catch(cause => { if (feed === changes) error = errorText(cause); }));
    return () => { changes.dispose(); off(); if (feed === changes) feed = null; };
  });
  async function refresh(): Promise<void> {
    const client = store.client, changes = feed;
    if (!client || !changes) return;
    loading = true;
    try { await changes.read(() => client.call('devices.list', { threadId }), value => { list = value; sessions = value.sessions; }); error = ''; }
    catch (cause) { error = errorText(cause); }
    finally { loading = false; }
  }
  async function act<T>(run: () => Promise<T>): Promise<T | undefined> {
    busy = true;
    try { const value = await run(); error = ''; return value; }
    catch (cause) { error = errorText(cause); return undefined; }
    finally { busy = false; kick(); }
  }
  async function open(deviceId: string): Promise<void> {
    const client = store.client;
    if (!client) return;
    const opened = await act(() => client.call('devices.open', { threadId, deviceId }));
    if (opened) { selected = deviceId; picking = false; }
  }
  async function close(shutdown: boolean): Promise<void> {
    const client = store.client, target = session;
    if (!client || !target) return;
    await act(() => client.call('devices.close', { threadId, deviceId: target.deviceId, ...(shutdown ? { shutdown } : {}) }));
  }
  async function input(value: MobileDeviceInput): Promise<boolean> {
    const client = store.client, target = showing;
    if (!client || !target || !usable) return false;
    return (await act(() => client.call('devices.input', { threadId, deviceId: target.deviceId, input: value }))) !== undefined;
  }
  /** The connection and device shown now, where an input made now goes. */
  function inputTarget(): InputTarget | null {
    const client = store.client;
    return client && showing ? { client, deviceId: showing.deviceId } : null;
  }
  /** Characters typed while adb is busy leave together in the next text; a finger's moves still waiting keep only the latest. Only inputs for the same device merge. */
  function direct(value: MobileDeviceInput, to = inputTarget()) {
    if (!to) return;
    const queued = typed.at(-1), last = queued && queued.to.client === to.client && queued.to.deviceId === to.deviceId ? queued.input : undefined;
    if (value.kind === 'text' && last?.kind === 'text' && last.text.length + value.text.length <= MOBILE_TEXT_MAX) queued!.input = { kind: 'text', text: last.text + value.text };
    else if (value.kind === 'touch' && value.action === 'move' && last?.kind === 'touch' && last.action === 'move' && last.pointerId === value.pointerId) queued!.input = value;
    else typed.push({ to, input: value });
    typing ??= drain().finally(() => { typing = null; });
  }
  async function drain(): Promise<void> {
    while (typed.length) {
      const { to, input: value } = typed.shift()!, client = store.client, target = showing;
      if (!alive || !client || store.connection !== 'ready') { typed = []; return; }
      const lift = value.kind === 'touch' && (value.action === 'up' || value.action === 'cancel');
      // A finger lifted still reaches the device it pressed, which would otherwise keep it down; anything else made for another device is dropped.
      if (to.client !== client || (!lift && (to.deviceId !== target?.deviceId || !target.input))) continue;
      // A pause drops what was typed, lifts excepted.
      if (paused && !lift) continue;
      try { await client.call('devices.input', { threadId, deviceId: to.deviceId, input: value }); error = ''; }
      catch (cause) { typed = []; if (alive) error = errorText(cause); return; }
      finally { if (alive) kick(); }
    }
  }
  function pasted(value: string) {
    // The stream sets the device's clipboard and pastes it, lines and any character included.
    if (live) { direct({ kind: 'clipboard', text: value.slice(0, MOBILE_CLIPBOARD_MAX), paste: true }); return; }
    const line = devicePaste(value);
    if (line === null) { error = strings.devicePanel.ascii; return; }
    for (let at = 0; at < line.length; at += MOBILE_TEXT_MAX) direct({ kind: 'text', text: line.slice(at, at + MOBILE_TEXT_MAX) });
  }
  /** Wheel notches become one swipe from under the pointer, the way a finger would scroll that far; the stream takes the notches themselves. */
  function wheel(event: WheelEvent) {
    if (event.ctrlKey || !usable || !showing?.input) return;
    if (live) { event.preventDefault(); scrolled(event); return; }
    if (!frame) return;
    event.preventDefault();
    const at = pixel(event, frame);
    if (!at || !picture) return;
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 400 : 1, current = frame, to = inputTarget();
    if (!to) return;
    wheelAt ??= { ...at, to };
    wheelY += event.deltaY * unit * current.width / Math.max(1, picture.getBoundingClientRect().width);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      const from = wheelAt, reach = Math.round(current.height * .6), by = Math.max(-reach, Math.min(reach, Math.round(wheelY)));
      wheelAt = null; wheelY = 0;
      if (!from || !by) return;
      direct({ kind: 'swipe', from: { x: from.x, y: from.y }, to: { x: from.x, y: Math.max(0, Math.min(current.height - 1, from.y - by)) }, durationMs: 150 }, from.to);
    }, 80);
  }
  /** A notch is 100 pixels or 3 lines of the browser's wheel; what turns within 40 ms leaves as one scroll. */
  function scrolled(event: WheelEvent) {
    const at = streamPoint(event, false), to = inputTarget();
    if (!at || !to) return;
    const notch = event.deltaMode === 1 ? 1 / 3 : event.deltaMode === 2 ? 3 : 1 / 100;
    notchAt ??= { ...at, to };
    notches = { x: notches.x + event.deltaX * notch, y: notches.y + event.deltaY * notch };
    notchTimer ??= setTimeout(() => {
      const from = notchAt, by = notches, fit = (n: number) => Math.max(-MOBILE_SCROLL_MAX, Math.min(MOBILE_SCROLL_MAX, Math.round(n * 100) / 100));
      notchAt = null; notches = { x: 0, y: 0 }; notchTimer = undefined;
      if (from && (fit(by.x) || fit(by.y))) direct({ kind: 'scroll', x: from.x, y: from.y, dx: fit(by.x), dy: fit(by.y) }, from.to);
    }, 40);
  }
  $effect(() => {
    const node = screen;
    if (!node) return;
    node.addEventListener('wheel', wheel, { passive: false });
    return () => node.removeEventListener('wheel', wheel);
  });
  async function screenshot(): Promise<void> {
    const client = store.client, target = showing;
    if (!client || !target) return;
    const shot = await act(() => client.call('devices.screenshot', { threadId, deviceId: target.deviceId }));
    if (!shot) return;
    const link = document.createElement('a');
    link.href = `data:image/png;base64,${shot.base64}`;
    link.download = `${target.deviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    link.click();
  }
  /** The device's selection, copied (or cut) there and read through the stream. */
  async function deviceCopy(cut: boolean): Promise<string> {
    const client = store.client, target = showing;
    if (!client || !target || !live) return '';
    const { text } = await client.call('devices.clipboard', { threadId, deviceId: target.deviceId, copy: cut ? 'cut' : 'copy' });
    notice = text ? strings.devicePanel.copied : strings.devicePanel.copyEmpty;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice = ''; }, 3000);
    return text;
  }
  const fallbackNote = (reason: StreamFallback) => reason.why === 'off' ? strings.devicePanel.streamOff
    : reason.why === 'decoder' ? strings.devicePanel.streamDecoder
    : reason.why === 'failed' ? fill(strings.devicePanel.streamFailed, { reason: reason.reason }).trim() : '';

  onMount(() => {
    const keyboard = liveInput(() => viewer, {
      key(event) {
        if (!showing?.input || (!frame && !live) || paused) return false;
        // The stream types any character; adb only printable ASCII.
        const sent = deviceKey(event, live);
        if (!sent) return false;
        direct('key' in sent ? { kind: 'key', key: sent.key } : { kind: 'text', text: sent.text });
        return true;
      },
      paste(value) { if (showing?.input) pasted(value); },
      copy: deviceCopy,
      failed(reason) { error = reason; },
    });
    const visibility = () => { pageHidden = document.hidden; if (document.hidden) stop(); else resume(); };
    const back = () => { if (!document.hidden && !pending) resume(); };
    document.addEventListener('visibilitychange', visibility);
    for (const name of ['pageshow', 'online', 'focus'] as const) window.addEventListener(name, back);
    return () => {
      alive = false; stop(); keyboard.destroy(); clearTimeout(wheelTimer); clearTimeout(notchTimer); clearTimeout(noticeTimer);
      document.removeEventListener('visibilitychange', visibility);
      for (const name of ['pageshow', 'online', 'focus'] as const) window.removeEventListener(name, back);
    };
  });
  function hide() { liveViews.hide('device', key); stop(); frame = null; }
  // A new device, a device that finished starting, a pause, the cover lifted or a reconnect restarts the frames.
  $effect(() => {
    const ready = store.connection === 'ready', id = showing?.deviceId;
    if (paused || !id) { untrack(stop); return; }
    untrack(() => {
      if (frame && frame.deviceId !== id) frame = null;
      if (ready) failures = 0;
      resume();
    });
  });
  // An Android device shown and not paused plays its live stream; the screenshots above fill in until it does, or when it cannot.
  $effect(() => {
    const ready = store.connection === 'ready', client = store.client, deviceId = streamDevice;
    if (paused || pageHidden || !ready || !client || !deviceId) return;
    if (!canDecode()) {
      untrack(() => { streamNote = store.settings?.deviceStream === true ? strings.devicePanel.streamDecoder : ''; });
      return;
    }
    let streamError = '';
    const player = playDeviceStream({
      ask: after => client.call('devices.stream', { threadId, deviceId, maxSize: streamSize({ width: areaWidth, height: areaHeight }, window.devicePixelRatio, !desk), ...(after ? { after } : {}) }),
      canvas: () => canvas,
      live(picture) { stream = picture; streamNote = ''; stop(); frame = null; },
      fallback(reason) { stream = null; fingers.clear(); streamNote = fallbackNote(reason); resume(); },
      error(message) { if (stream) error = streamError = message; },
      // Only the error the stream reported clears; one from an input stays until the next input.
      ok() { if (streamError && error === streamError) error = ''; streamError = ''; },
    });
    return () => {
      player.stop();
      untrack(() => {
        // Fingers still down are lifted on the device this effect played, before a pause, a hidden page or another device.
        for (const finger of fingers.values()) void client.call('devices.input', { threadId, deviceId, input: { kind: 'touch', action: 'cancel', x: 0, y: 0, pointerId: finger } }).catch(() => {});
        fingers.clear();
        // A pause or a hidden page keeps the last picture on the canvas; anything else goes back to screenshots.
        if (!paused && !pageHidden) stream = null;
      });
    };
  });

  /** Where a pointer is on the live stream, in the screen's pixels; `clamp` keeps a drag that left the picture at its edge. */
  function streamPoint(event: MouseEvent, clamp: boolean): { x: number; y: number } | null {
    const current = stream, box = canvas?.getBoundingClientRect();
    if (!current || !box || !(box.width > 0 && box.height > 0)) return null;
    const scale = Math.min(box.width / current.width, box.height / current.height), width = current.width * scale, height = current.height * scale;
    const x = (event.clientX - box.left - (box.width - width) / 2) / width, y = (event.clientY - box.top - (box.height - height) / 2) / height;
    if (!clamp && !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
    const fit = (n: number, size: number) => Math.round(Math.max(0, Math.min(1, n)) * (size - 1));
    return { x: fit(x, current.screen.width), y: fit(y, current.screen.height) };
  }
  /** A finger on the stream: down, its moves and up reach the device as they happen, so a drag is a real drag. */
  function touchDown(event: PointerEvent) {
    if (!usable || !showing?.input || event.button !== 0) return;
    const at = streamPoint(event, false), used = new Set(fingers.values()), finger = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].find(n => !used.has(n));
    if (!at || finger === undefined) return;
    fingers.set(event.pointerId, finger);
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture?.(event.pointerId);
    direct({ kind: 'touch', action: 'down', ...at, pointerId: finger });
  }
  function touchMove(event: PointerEvent) {
    const finger = fingers.get(event.pointerId), at = finger === undefined ? null : streamPoint(event, true);
    if (finger !== undefined && at) direct({ kind: 'touch', action: 'move', ...at, pointerId: finger });
  }
  function touchEnd(event: PointerEvent, action: 'up' | 'cancel') {
    const finger = fingers.get(event.pointerId);
    if (finger === undefined) return;
    fingers.delete(event.pointerId);
    direct({ kind: 'touch', action, ...(streamPoint(event, true) ?? { x: 0, y: 0 }), pointerId: finger });
  }

  /** Where a touch lands, in the device's own screen pixels: what `devices.input` and the agent use. */
  function pixel(event: MouseEvent, current: MobileDeviceFrame): { x: number; y: number } | null {
    const at = picture ? framePoint(picture.getBoundingClientRect(), current, event.clientX, event.clientY) : null;
    return at ? { x: Math.round(at.x * (current.width - 1)), y: Math.round(at.y * (current.height - 1)) } : null;
  }
  function down(event: PointerEvent) {
    if (live) { touchDown(event); return; }
    if (!usable || !frame || !showing?.input || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, at: performance.now(), frame };
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function up(event: PointerEvent) {
    if (fingers.has(event.pointerId)) { touchEnd(event, 'up'); return; }
    const start = pointer; pointer = undefined;
    if (!start) return;
    const end = pixel(event, start.frame);
    if (!end) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 8) { void input({ kind: 'tap', ...end }); return; }
    const from = picture ? framePoint(picture.getBoundingClientRect(), start.frame, start.x, start.y) : null;
    if (!from) return;
    const durationMs = Math.max(100, Math.min(2000, Math.round(performance.now() - start.at)));
    void input({ kind: 'swipe', from: { x: Math.round(from.x * (start.frame.width - 1)), y: Math.round(from.y * (start.frame.height - 1)) }, to: end, durationMs });
  }
  async function sendText(enter: boolean) {
    const value = text;
    if (value && !live && !isAdbText(value)) { error = strings.devicePanel.ascii; return; }
    if (value && !await input({ kind: 'text', text: value })) return;
    text = '';
    if (enter) await input({ kind: 'key', key: 'enter' });
  }
  function textKey(event: KeyboardEvent) {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); void sendText(true); }
    else if (event.key === 'Backspace' && text === '') { event.preventDefault(); void input({ kind: 'key', key: 'backspace' }); }
  }
  const stateLabel = (state: MobileDevice['state']) => state === 'running' ? strings.devicePanel.running : state === 'stopped' ? strings.devicePanel.stopped : strings.devicePanel.booting;
</script>

<section class="device" data-testid="device-surface" aria-label={strings.rightPanel.device}>
  {#if sessions.length > 0}
    <div class="toolbar">
      <div class="tabs" role="tablist">
        {#each sessions as one (one.deviceId)}
          <button type="button" role="tab" class="chip" aria-selected={one.deviceId === session?.deviceId} data-testid="device-tab" onclick={() => { selected = one.deviceId; picking = false; }}>
            <span class="dot" class:ready={one.state === 'ready'} class:failed={one.state === 'failed'}></span><span class="ui-label">{one.name}</span>
          </button>
        {/each}
        <button type="button" class="chip" aria-label={strings.devicePanel.add} title={strings.devicePanel.add} aria-pressed={picking} data-testid="device-add" onclick={() => { picking = !picking; if (picking) void refresh(); }}><Plus size={16} /></button>
      </div>
      <div class="actions">
        {#if showing}<button type="button" class="chip" data-testid="device-hide" aria-label={strings.devicePanel.hideHint} title={strings.devicePanel.hideHint} onclick={hide}><EyeOff size={15} /><span class="ui-label">{strings.devicePanel.hide}</span></button>{/if}
        <button type="button" class="chip" disabled={!showing} aria-label={paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause} title={paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause} onclick={() => { paused = !paused; }}>{#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}</button>
        <button type="button" class="chip" disabled={!showing || busy} aria-label={strings.devicePanel.screenshot} title={strings.devicePanel.screenshot} data-testid="device-screenshot" onclick={() => void screenshot()}><Camera size={16} /></button>
        <button type="button" class="chip" disabled={!session || busy || session.state === 'booting'} aria-label={strings.devicePanel.shutdown} title={strings.devicePanel.shutdown} data-testid="device-shutdown" onclick={() => void close(true)}><Power size={16} /></button>
        <button type="button" class="chip" disabled={!session || busy} aria-label={session ? fill(strings.devicePanel.close, { name: session.name }) : ''} title={session ? fill(strings.devicePanel.close, { name: session.name }) : ''} data-testid="device-close" onclick={() => void close(false)}><X size={16} /></button>
      </div>
    </div>
  {/if}
  {#if error}<p class="error" role="status" data-testid="device-error">{error}</p>{/if}

  {#if sessions.length === 0 || picking}
    <div class="picker" data-testid="device-picker">
      {#if sessions.length === 0}<p class="muted">{strings.devicePanel.empty}</p>{/if}
      <div class="heading"><span class="section-label">{strings.devicePanel.onMachine}</span>
        <button type="button" class="chip" disabled={loading} onclick={() => void refresh()}><RefreshCw size={14} /><span class="ui-label">{strings.common.refresh}</span></button></div>
      {#if list}
        {#each list.hosts as host (host.id)}
          {#each host.platforms.filter(one => one.reason) as platform (platform.platform)}
            <p class="muted reason" data-testid="device-reason">{platform.platform === 'ios' ? 'iOS' : 'Android'}: {platform.reason}</p>
          {/each}
        {/each}
        {#if list.devices.length === 0}<p class="muted">{strings.devicePanel.none}</p>{/if}
        <ul>
          {#each list.devices as device (device.id)}
            {@const shown = sessions.some(one => one.deviceId === device.id)}
            <li>
              <span class="name">{device.name}<small>{device.platform === 'ios' ? 'iOS' : 'Android'}{device.runtime ? ` · ${device.runtime}` : ''} · {stateLabel(device.state)}</small></span>
              <button type="button" class="chip" disabled={busy || shown} data-testid="device-open" onclick={() => void open(device.id)}><span class="ui-label">{strings.common.open}</span></button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if session}
    <div class="viewer" bind:this={viewer} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
      {#if session.state === 'booting'}
        <p class="muted center" data-testid="device-starting">{fill(strings.devicePanel.starting, { name: session.name })}</p>
      {:else if !revealed && session.state === 'ready'}
        <div class="cover" data-testid="device-cover">
          <div class="card">
            <Smartphone size={22} strokeWidth={1.75} />
            <p class="heading" data-testid="device-cover-text">{fill(strings.devicePanel.cover, { machine })}</p>
            <p class="muted">{session.name}</p>
            <p class="muted">{strings.devicePanel.coverHint}</p>
            <button type="button" class="primary" data-testid="device-show" onclick={() => liveViews.show('device', key)}><span class="ui-label">{strings.devicePanel.show}</span></button>
          </div>
        </div>
      {:else if session.state === 'failed'}
        <div class="center"><p class="error">{fill(strings.devicePanel.failed, { name: session.name })}</p>{#if session.error}<p class="muted detail">{session.error}</p>{/if}</div>
      {:else}
        {@const still = !live && frame?.deviceId === session.deviceId ? frame : null}
        <!-- The canvas is there before the stream's first frame, which it draws; screenshots show until then. -->
        <button bind:this={screen} type="button" class="screen" hidden={!live && !still} class:stale={paused || !!error} class:view-only={!session.input} aria-label={desk && session.input ? strings.devicePanel.interactDesk : strings.devicePanel.interact} disabled={!usable || !session.input}
          onpointerdown={down} onpointermove={e => { if (fingers.has(e.pointerId)) touchMove(e); }} onpointerup={up}
          onpointercancel={e => { if (fingers.has(e.pointerId)) touchEnd(e, 'cancel'); else pointer = undefined; }} oncontextmenu={e => e.preventDefault()}>
          <canvas bind:this={canvas} hidden={!live} data-testid="device-stream">{fill(strings.devicePanel.image, { name: session.name })}</canvas>
          {#if still}<img bind:this={picture} src={`data:image/jpeg;base64,${still.base64}`} alt={fill(strings.devicePanel.image, { name: session.name })} draggable="false" data-testid="device-frame" />{/if}
        </button>
        {#if !live && !still}<p class="muted center">{strings.remoteBrowser.waiting}</p>{/if}
      {/if}
    </div>
    {#if showing}
      <footer>
        {#if showing.input}
          <div class="keys">
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.back} title={strings.devicePanel.back} onclick={() => void input({ kind: 'key', key: 'back' })}><Triangle size={14} style="transform: rotate(-90deg)" /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.home} title={strings.devicePanel.home} onclick={() => void input({ kind: 'key', key: 'home' })}><Circle size={15} /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.recents} title={strings.devicePanel.recents} onclick={() => void input({ kind: 'key', key: 'recents' })}><Square size={14} /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.rotate} title={strings.devicePanel.rotate} onclick={() => void input({ kind: 'key', key: 'rotate' })}><RotateCw size={15} /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.power} title={strings.devicePanel.power} onclick={() => void input({ kind: 'key', key: 'power' })}><Power size={15} /></button>
            {#if !desk}
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.enter} title={strings.devicePanel.enter} onclick={() => void input({ kind: 'key', key: 'enter' })}><CornerDownLeft size={15} /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.backspace} title={strings.devicePanel.backspace} onclick={() => void input({ kind: 'key', key: 'backspace' })}><Delete size={15} /></button>
            {#if live}<button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.copy} title={strings.devicePanel.copy} data-testid="device-copy"
              onclick={() => void writeClipboardLater(deviceCopy(false)).catch(cause => { error = errorText(cause); })}><Copy size={15} /></button>{/if}
            {/if}
          </div>
          {#if desk}<small data-testid="device-desk-hint">{live ? strings.devicePanel.deskHintLive : strings.devicePanel.deskHint}</small>{:else}
          <form onsubmit={e => { e.preventDefault(); void sendText(false); }}>
            <input bind:value={text} data-testid="device-text" maxlength="500" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={strings.devicePanel.text} placeholder={strings.devicePanel.text} onkeydown={textKey} />
            <button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.devicePanel.send}><Send size={16} /></button>
          </form>
          <small>{strings.devicePanel.gesture}</small>
          {/if}
        {:else}<small data-testid="device-view-only">{strings.devicePanel.viewOnly}</small>{/if}
        {#if notice || streamNote}<p class="muted note" role="status" data-testid="device-stream-note">{notice || streamNote}</p>{/if}
      </footer>
    {/if}
  {/if}
</section>

<style>
  .device { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
  .tabs, .actions, .keys { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  /* A desktop panel's controls are its size; a finger gets the touch target (the rule at the end of this block). */
  .chip { min-height: var(--control); min-width: var(--control); justify-content: center; }
  .tabs [aria-selected=true], .chip[aria-pressed=true] { color: var(--color-accent); border-color: var(--color-accent); }
  .dot { width: 8px; height: 8px; border-radius: var(--radius-full); background: var(--color-muted-foreground); flex: none; }
  .dot.ready { background: var(--color-accent); } .dot.failed { background: var(--color-danger); }
  .muted, small { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin: 0; padding: 0 16px 8px; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; max-height: 90px; overflow: auto; }
  .picker { padding: 8px 16px 16px; display: grid; gap: 8px; align-content: start; overflow: auto; }
  .picker p { margin: 0; } .heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .reason { overflow-wrap: anywhere; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  li { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); }
  .name { display: grid; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
  .viewer { position: relative; flex: 1; min-height: 80px; display: flex; overflow: hidden; background: var(--color-background); }
  .cover { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 360px; width: 100%; padding: 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); }
  .card p { margin: 0; overflow-wrap: anywhere; } .card .heading { font-weight: 600; } .card button { min-height: var(--control); min-width: 120px; justify-content: center; }
  .center { margin: auto; padding: 24px; text-align: center; } .center .error { padding: 0; } .detail { margin: 8px 0 0; overflow-wrap: anywhere; }
  .screen { position: relative; flex: 1; height: auto; min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; touch-action: none; cursor: crosshair; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .screen:disabled { opacity: 1; } .screen.view-only { cursor: default; } .screen.stale { opacity: .55; }
  img, canvas { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); object-fit: contain; pointer-events: none; -webkit-user-select: none; user-select: none; }
  .screen[hidden], canvas[hidden] { display: none; }
  .note { margin: 0; overflow-wrap: anywhere; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); display: grid; gap: 8px; }
  form { display: flex; gap: 8px; } input { min-width: 0; flex: 1; font-size: 16px; min-height: var(--control); }
  @media (max-width: 720px) { footer small { display: none; } .toolbar, footer, .picker { padding-inline: 12px; } }
  /* Last, so it outranks the desktop sizes of the same weight above. */
  @media (pointer: coarse) { .chip { min-height: var(--touch-target); min-width: var(--touch-target); } .card button, input { min-height: var(--touch-target); } }
</style>
