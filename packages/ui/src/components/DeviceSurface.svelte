<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { Camera, Circle, CornerDownLeft, Delete, Pause, Play, Plus, Power, RefreshCw, RotateCw, Send, Square, Triangle, X } from '@lucide/svelte';
  import type { MobileDevice, MobileDeviceFrame, MobileDeviceInput, MobileDeviceList, MobileDeviceSession } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { FRAME_INTERVAL, frameMaxWidth, framePoint, frameQuality, nextPollDelay } from '../lib/remote-browser-view';
  /**
   * The simulators and emulators open in this conversation, live (docs/devices.md).
   * The core captures their screen; this polls JPEG frames the way the phone's
   * browser view does, so it works the same on the desktop and on a paired phone.
   */
  let { store, threadId }: { store: Store; threadId: string } = $props();
  let sessions = $state.raw<MobileDeviceSession[]>([]), selected = $state<string | null>(null);
  let list = $state.raw<MobileDeviceList | null>(null), picking = $state(false), loading = $state(false);
  let frame = $state.raw<MobileDeviceFrame | null>(null), picture = $state<HTMLImageElement>();
  let paused = $state(false), busy = $state(false), error = $state(''), text = $state(''), areaWidth = $state(0);
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, pending = false, requestedAt = 0;
  let roundTrip = 0, unchanged = 0, failures = 0;
  let pointer: { x: number; y: number; at: number; frame: MobileDeviceFrame } | undefined;
  const session = $derived(sessions.find(one => one.deviceId === selected) ?? sessions[0] ?? null);
  const showing = $derived(session?.state === 'ready' ? session : null);
  const usable = $derived(!!showing && !!frame && frame.deviceId === showing.deviceId && !paused && !busy && store.connection === 'ready');
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

  function stop() { generation++; clearTimeout(timer); }
  async function decoded(base64: string): Promise<void> {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
  }
  async function poll(run: number): Promise<void> {
    const target = showing;
    if (!alive || run !== generation || paused || document.hidden || !target) return;
    if (pending || busy) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client, started = performance.now();
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const maxWidth = frameMaxWidth(areaWidth, window.devicePixelRatio), quality = frameQuality(roundTrip);
      const next = await client.call('devices.frame', { threadId, deviceId: target.deviceId, ...(maxWidth ? { maxWidth } : {}), quality });
      if (next.base64 !== frame?.base64) await decoded(next.base64);
      if (!alive || run !== generation) return;
      roundTrip = performance.now() - started; failures = 0;
      unchanged = frame && next.base64 === frame.base64 ? unchanged + 1 : 0;
      frame = next; error = '';
    } catch (cause) {
      if (alive && run === generation) { failures++; error = message(cause); }
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

  async function refresh(): Promise<void> {
    const client = store.client;
    if (!client) return;
    loading = true;
    try { list = await client.call('devices.list', { threadId }); sessions = list.sessions; error = ''; }
    catch (cause) { error = message(cause); }
    finally { loading = false; }
  }
  async function act<T>(run: () => Promise<T>): Promise<T | undefined> {
    busy = true;
    try { const value = await run(); error = ''; return value; }
    catch (cause) { error = message(cause); return undefined; }
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

  onMount(() => {
    const client = store.client;
    const off = client?.on('devices.changed', event => {
      if (event.threadId !== threadId) return;
      const known = new Set(sessions.map(one => one.deviceId));
      sessions = event.sessions;
      // A device just opened, by the agent or here, comes to the front.
      const added = event.sessions.find(one => !known.has(one.deviceId));
      if (added) { selected = added.deviceId; picking = false; }
      if (event.sessions.length === 0) void refresh();
    });
    void client?.call('devices.sessions', { threadId }).then(result => {
      sessions = result.sessions;
      if (result.sessions.length === 0) void refresh();
    }, cause => { error = message(cause); });
    const visibility = () => { if (document.hidden) stop(); else resume(); };
    const back = () => { if (!document.hidden && !pending) resume(); };
    document.addEventListener('visibilitychange', visibility);
    for (const name of ['pageshow', 'online', 'focus'] as const) window.addEventListener(name, back);
    return () => {
      alive = false; stop(); off?.();
      document.removeEventListener('visibilitychange', visibility);
      for (const name of ['pageshow', 'online', 'focus'] as const) window.removeEventListener(name, back);
    };
  });
  // A new device, a device that finished starting, a pause or a reconnect restarts the frames.
  $effect(() => {
    const ready = store.connection === 'ready', id = showing?.deviceId;
    if (paused || !id) { untrack(stop); return; }
    untrack(() => {
      if (frame && frame.deviceId !== id) frame = null;
      if (ready) failures = 0;
      resume();
    });
  });

  /** Where a touch lands, in the device's own screen pixels: what `devices.input` and the agent use. */
  function pixel(event: PointerEvent, current: MobileDeviceFrame): { x: number; y: number } | null {
    const at = picture ? framePoint(picture.getBoundingClientRect(), current, event.clientX, event.clientY) : null;
    return at ? { x: Math.round(at.x * (current.width - 1)), y: Math.round(at.y * (current.height - 1)) } : null;
  }
  function down(event: PointerEvent) {
    if (!usable || !frame || !showing?.input || event.button !== 0) return;
    pointer = { x: event.clientX, y: event.clientY, at: performance.now(), frame };
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function up(event: PointerEvent) {
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
    if (value && !/^[\x20-\x7e]+$/.test(value)) { error = strings.devicePanel.ascii; return; }
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
        <button type="button" class="chip" disabled={loading} onclick={() => void refresh()}><RefreshCw size={14} /><span class="ui-label">{strings.devicePanel.refresh}</span></button></div>
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
              <button type="button" class="chip" disabled={busy || shown} data-testid="device-open" onclick={() => void open(device.id)}><span class="ui-label">{strings.devicePanel.open}</span></button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {:else if session}
    <div class="viewer" bind:clientWidth={areaWidth}>
      {#if session.state === 'booting'}
        <p class="muted center" data-testid="device-starting">{fill(strings.devicePanel.starting, { name: session.name })}</p>
      {:else if session.state === 'failed'}
        <div class="center"><p class="error">{fill(strings.devicePanel.failed, { name: session.name })}</p>{#if session.error}<p class="muted detail">{session.error}</p>{/if}</div>
      {:else if frame && frame.deviceId === session.deviceId}
        <button type="button" class="screen" class:stale={paused || !!error} class:view-only={!session.input} aria-label={strings.devicePanel.interact} disabled={!usable || !session.input}
          onpointerdown={down} onpointerup={up} onpointercancel={() => { pointer = undefined; }} oncontextmenu={e => e.preventDefault()}>
          <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={fill(strings.devicePanel.image, { name: session.name })} draggable="false" data-testid="device-frame" />
        </button>
      {:else}<p class="muted center">{strings.remoteBrowser.waiting}</p>{/if}
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
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.enter} title={strings.devicePanel.enter} onclick={() => void input({ kind: 'key', key: 'enter' })}><CornerDownLeft size={15} /></button>
            <button type="button" class="chip" disabled={!usable} aria-label={strings.devicePanel.backspace} title={strings.devicePanel.backspace} onclick={() => void input({ kind: 'key', key: 'backspace' })}><Delete size={15} /></button>
          </div>
          <form onsubmit={e => { e.preventDefault(); void sendText(false); }}>
            <input bind:value={text} data-testid="device-text" maxlength="500" enterkeyhint="send" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={strings.devicePanel.text} placeholder={strings.devicePanel.text} onkeydown={textKey} />
            <button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.devicePanel.send}><Send size={16} /></button>
          </form>
          <small>{strings.devicePanel.gesture}</small>
        {:else}<small data-testid="device-view-only">{strings.devicePanel.viewOnly}</small>{/if}
      </footer>
    {/if}
  {/if}
</section>

<style>
  .device { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
  .tabs, .actions, .keys { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .chip { min-height: 44px; min-width: 44px; justify-content: center; }
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
  .center { margin: auto; padding: 24px; text-align: center; } .center .error { padding: 0; } .detail { margin: 8px 0 0; overflow-wrap: anywhere; }
  .screen { position: relative; flex: 1; height: auto; min-width: 0; padding: 0; border: 0; border-radius: 0; background: transparent; touch-action: none; cursor: crosshair; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; -webkit-tap-highlight-color: transparent; }
  .screen:disabled { opacity: 1; } .screen.view-only { cursor: default; } .screen.stale { opacity: .55; }
  img { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); object-fit: contain; pointer-events: none; -webkit-user-select: none; user-select: none; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); display: grid; gap: 8px; }
  form { display: flex; gap: 8px; } input { min-width: 0; flex: 1; font-size: 16px; min-height: 44px; }
  @media (max-width: 720px) { footer small { display: none; } .toolbar, footer, .picker { padding-inline: 12px; } }
</style>
