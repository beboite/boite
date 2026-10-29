<script lang="ts">
  import { errorText } from '../lib/errors';
  import { onMount, untrack } from 'svelte';
  import { AppWindow, EyeOff, X } from '@lucide/svelte';
  import type { WindowFrame, WindowWatch } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { fill, strings } from '../lib/strings';
  import { FRAME_INTERVAL, frameMaxWidth, frameQuality, nextPollDelay, type PollState } from '../lib/remote-browser-view';
  import { liveViews, machineName } from '../lib/live-view.svelte';
  import { SnapshotFeed } from '../lib/snapshot-feed';
  /**
   * The desktop window an agent opened in this conversation with
   * `boite window watch` (docs/windows.md), read-only. Like the Device panel,
   * nothing is captured until the user shows it: a card covers the view and
   * names the machine. Shown, it polls JPEG frames a few times a second, passing
   * the last frame's id so a still window answers `unchanged` without a picture.
   * No pointer or key ever reaches the window.
   */
  let { store, threadId }: { store: Store; threadId: string } = $props();
  const s = strings.windows.panel;
  let watch = $state.raw<WindowWatch | null>(null), loaded = $state(false);
  let frame = $state.raw<WindowFrame | null>(null), error = $state(''), busy = $state(false), areaWidth = $state(0);
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined, pending = false, requestedAt = 0;
  // `pictureTrip` sets the JPEG quality from answers that carried a picture: a quick `unchanged` must not change it, which would change the frame's id.
  let roundTrip = 0, pictureTrip = 0, unchanged = 0, failures = 0;
  const key = $derived(store.threadKey(threadId));
  const revealed = $derived(liveViews.shown('window', key));
  const machine = $derived(machineName(store));
  const showing = $derived(watch && revealed ? watch : null);
  const still = $derived(showing && frame?.windowId === showing.windowId ? frame : null);

  /** At most four frames a second, at least two while the window is still; a failure backs off as the other live views do. */
  const delay = (state: PollState) => state.failures > 0 ? nextPollDelay(state) : Math.min(nextPollDelay(state), Math.max(0, 2 * FRAME_INTERVAL - state.roundTrip));

  function stop() { generation++; clearTimeout(timer); }
  async function decoded(base64: string): Promise<void> {
    const image = new Image();
    image.src = `data:image/jpeg;base64,${base64}`;
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
  }
  async function poll(run: number): Promise<void> {
    const target = showing;
    if (!alive || run !== generation || document.hidden || !target) return;
    if (pending) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    const client = store.client, started = performance.now();
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const maxWidth = frameMaxWidth(areaWidth, window.devicePixelRatio), quality = frameQuality(pictureTrip);
      const previous = frame?.windowId === target.windowId ? frame.id : undefined;
      const next = await client.call('windows.frame', { threadId, windowId: target.windowId, ...(maxWidth ? { maxWidth } : {}), quality, ...(previous ? { previous } : {}) });
      if (!next.unchanged && next.base64 !== frame?.base64) await decoded(next.base64);
      if (!alive || run !== generation) return;
      roundTrip = performance.now() - started; failures = 0;
      unchanged = next.unchanged ? unchanged + 1 : 0;
      if (!next.unchanged) { pictureTrip = roundTrip; frame = next; }
      error = '';
    } catch (cause) {
      // Minimized, closed or black: said in the panel, over the last picture.
      if (alive && run === generation) { failures++; error = errorText(cause); }
    } finally { pending = false; }
    if (alive && run === generation) timer = setTimeout(() => void poll(run), delay({ roundTrip, unchanged, failures }));
  }
  function resume() {
    stop();
    if (!document.hidden && showing) {
      const run = generation;
      timer = setTimeout(() => void poll(run), Math.max(0, FRAME_INTERVAL - (Date.now() - requestedAt)));
    }
  }

  onMount(() => {
    const client = store.client;
    // A change that lands while the list is out is applied after it, never under it.
    const changes = new SnapshotFeed<WindowWatch | null>(next => { watch = next; loaded = true; });
    const off = client?.on('windows.changed', event => { if (event.threadId === threadId) changes.push(event.watch); });
    if (client) void changes.read(() => client.call('windows.list', { threadId }), result => { watch = result.watch; loaded = true; })
      .catch(cause => { error = errorText(cause); loaded = true; });
    const visibility = () => { if (document.hidden) stop(); else resume(); };
    const back = () => { if (!document.hidden && !pending) resume(); };
    document.addEventListener('visibilitychange', visibility);
    for (const name of ['pageshow', 'online', 'focus'] as const) window.addEventListener(name, back);
    return () => {
      alive = false; stop(); off?.(); changes.dispose();
      document.removeEventListener('visibilitychange', visibility);
      for (const name of ['pageshow', 'online', 'focus'] as const) window.removeEventListener(name, back);
    };
  });
  // Another window, the cover lifted or a reconnect restarts the frames; the cover put back or the watch closed stops them.
  $effect(() => {
    const ready = store.connection === 'ready', id = showing?.windowId, opened = showing?.openedAt;
    if (!id) { untrack(stop); return; }
    void opened;
    untrack(() => {
      if (frame && frame.windowId !== id) frame = null;
      if (ready) failures = 0;
      resume();
    });
  });
  function hide() { liveViews.hide('window', key); stop(); frame = null; error = ''; }
  async function close(): Promise<void> {
    const client = store.client;
    if (!client) return;
    busy = true;
    try { await client.call('windows.close', { threadId }); watch = null; frame = null; error = ''; stop(); }
    catch (cause) { error = errorText(cause); }
    finally { busy = false; }
  }
</script>

<section class="window" data-testid="window-surface" aria-label={strings.rightPanel.window}>
  {#if watch}
    <div class="toolbar">
      <div class="what">
        <AppWindow size={16} />
        <span class="process ui-label" data-testid="window-process">{watch.process}</span>
        {#if watch.title}<span class="title" title={watch.title} data-testid="window-title">{watch.title}</span>{/if}
      </div>
      <div class="actions">
        {#if showing}<button type="button" class="chip" data-testid="window-hide" aria-label={s.hideHint} title={s.hideHint} onclick={hide}><EyeOff size={15} /><span class="ui-label">{s.hide}</span></button>{/if}
        <button type="button" class="chip" disabled={busy} aria-label={s.closeHint} title={s.closeHint} data-testid="window-close" onclick={() => void close()}><X size={16} /></button>
      </div>
    </div>
  {/if}
  {#if error}<p class="error" role="status" data-testid="window-error">{error}</p>{/if}

  {#if !watch}
    {#if loaded}<p class="muted center" data-testid="window-empty">{s.empty}</p>{/if}
  {:else}
    <div class="viewer" bind:clientWidth={areaWidth}>
      {#if !revealed}
        <div class="cover" data-testid="window-cover">
          <div class="card">
            <AppWindow size={22} strokeWidth={1.75} />
            <p class="heading" data-testid="window-cover-text">{fill(s.cover, { machine })}</p>
            <p class="muted">{watch.process}</p>
            <p class="muted">{s.coverHint}</p>
            <button type="button" class="primary" data-testid="window-show" onclick={() => liveViews.show('window', key)}><span class="ui-label">{s.show}</span></button>
          </div>
        </div>
      {:else if still}
        <!-- A picture, nothing more: no handler, no focus, so nothing reaches the window. -->
        <div class="screen" class:stale={!!error}>
          <img src={`data:image/jpeg;base64,${still.base64}`} width={still.width} height={still.height} alt={fill(s.picture, { process: watch.process })} draggable="false" data-testid="window-frame" />
        </div>
      {:else}
        <p class="muted center">{s.waiting}</p>
      {/if}
    </div>
    {#if showing}<footer><small data-testid="window-read-only">{s.readOnly}</small></footer>{/if}
  {/if}
</section>

<style>
  .window { flex: 1; min-height: 0; height: 100%; display: flex; flex-direction: column; }
  .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; }
  .what { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--color-muted-foreground); }
  .process { color: var(--color-foreground); font-weight: 600; flex: none; }
  .title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); }
  .actions { display: flex; gap: 6px; align-items: center; flex: none; }
  /* A desktop panel's controls are its size; a finger gets the touch target (the rule at the end of this block). */
  .chip { min-height: var(--control); min-width: var(--control); justify-content: center; }
  .muted, small { color: var(--color-muted-foreground); font-size: var(--text-sm); }
  .error { margin: 0; padding: 0 16px 8px; font-size: var(--text-sm); color: var(--color-danger); overflow-wrap: anywhere; max-height: 90px; overflow: auto; }
  .viewer { position: relative; flex: 1; min-height: 80px; display: flex; overflow: hidden; background: var(--color-background); }
  .cover { flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center; }
  .card { display: flex; flex-direction: column; align-items: center; gap: 10px; max-width: 360px; width: 100%; padding: 20px; border: 1px solid var(--color-border); border-radius: var(--radius-lg); background: var(--color-surface-2); box-shadow: var(--shadow-e2); }
  .card p { margin: 0; overflow-wrap: anywhere; } .card .heading { font-weight: 600; } .card button { min-height: var(--control); min-width: 120px; justify-content: center; }
  .center { margin: auto; padding: 24px; text-align: center; }
  .screen { position: relative; flex: 1; min-width: 0; -webkit-user-select: none; user-select: none; }
  .screen.stale { opacity: .55; }
  img { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); object-fit: contain; pointer-events: none; -webkit-user-select: none; user-select: none; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); }
  @media (max-width: 720px) { .toolbar, footer { padding-inline: 12px; } }
  /* Last, so it outranks the desktop sizes of the same weight above. */
  @media (pointer: coarse) { .chip { min-height: var(--touch-target); min-width: var(--touch-target); } .card button { min-height: var(--touch-target); } }
</style>
