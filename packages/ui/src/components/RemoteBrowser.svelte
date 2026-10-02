<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { MonitorPlay, X, Pause, Play, ArrowUp, ArrowDown, Send } from '@lucide/svelte';
  import type { RemoteBrowserFrame, RemoteBrowserInput } from '@boite/contracts';
  import type { Store } from '../lib/store.svelte';
  import { strings } from '../lib/strings';
  import { experimentOn } from '../lib/experiments.svelte';
  import { focusedElement, restoreFocus } from '../lib/focus';
  import { mobileOverlay } from '../lib/mobile-history';
  let { store, threadId }: { store: Store; threadId: string } = $props();
  const client = untrack(() => store.client);
  let shown = $state(false), paused = $state(false), busy = $state(false), error = $state(''), text = $state('');
  let frame = $state<RemoteBrowserFrame | null>(null), dialog = $state<HTMLDialogElement>(), picture = $state<HTMLImageElement>();
  let alive = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, requestedAt = 0;
  let pointer: { x: number; y: number; frame: RemoteBrowserFrame } | undefined;
  const enabled = $derived(experimentOn('remote-browser'));
  const usable = $derived(!!frame && !paused && !busy && !error && store.connection === 'ready');
  function stop() { generation++; clearTimeout(timer); }
  async function poll(run: number): Promise<void> {
    if (!alive || run !== generation || !shown || paused || document.hidden || !enabled) return;
    if (pending) { timer = setTimeout(() => void poll(run), 100); return; }
    pending = true; requestedAt = Date.now();
    try {
      if (!client || client.state !== 'ready') throw new Error(strings.remoteBrowser.reconnecting);
      const next = await client.call('browser.remoteFrame', { threadId });
      if (!alive || run !== generation) return;
      frame = next; error = '';
    } catch (cause) { if (alive && run === generation) error = String(cause); }
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
    if (!enabled) { shown = false; frame = null; text = ''; }
    if (shown && !paused && enabled) untrack(resume); else untrack(stop);
  });
  $effect(() => {
    if (!shown || !dialog) return;
    const node = dialog, previous = focusedElement(); node.showModal();
    const release = mobileOverlay(() => { shown = false; });
    return () => { release(); node.close(); text = ''; restoreFocus(previous); };
  });
  async function input(value: RemoteBrowserInput, target = frame): Promise<void> {
    if (!client || !target || !usable || Date.now() - target.at > 5000) return;
    busy = true;
    try { await client.call('browser.remoteInput', { threadId, frameId: target.id, input: value }); if (value.kind === 'text') text = ''; }
    catch (cause) { error = String(cause); }
    finally { busy = false; }
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
    pointer = { x: event.clientX, y: event.clientY, frame };
    event.currentTarget instanceof Element && event.currentTarget.setPointerCapture(event.pointerId);
  }
  function up(event: PointerEvent) {
    const start = pointer; pointer = undefined;
    if (!start) return;
    const dx = start.x - event.clientX, dy = start.y - event.clientY;
    if (Math.hypot(dx, dy) > 8) {
      const ratio = start.frame.width / (picture?.getBoundingClientRect().width || start.frame.width);
      void input({ kind: 'scroll', x: Math.max(-2000, Math.min(2000, dx * ratio)), y: Math.max(-2000, Math.min(2000, dy * ratio)) }, start.frame);
    } else { const p = point(event, start.frame); if (p) void input({ kind: 'tap', ...p, width: start.frame.width, height: start.frame.height }, start.frame); }
  }
</script>

{#if enabled}
  <button type="button" class="ghost small icon" data-testid="remote-browser-open" title={strings.remoteBrowser.title} aria-label={strings.remoteBrowser.title} onclick={() => { shown = true; paused = false; }}><MonitorPlay size={16} /></button>
{/if}
{#if shown && enabled}
  <dialog bind:this={dialog} data-testid="remote-browser-dialog" aria-label={strings.remoteBrowser.title} onkeydown={e => e.stopPropagation()} oncancel={e => { e.preventDefault(); shown = false; }}>
    <header><div><h2>{strings.remoteBrowser.title}</h2><small>{frame?.title || strings.remoteBrowser.waiting}</small></div><button type="button" class="ghost icon" aria-label={strings.imports.close} onclick={() => { shown = false; }}><X size={18} /></button></header>
    <div class="toolbar"><span class="state" class:live={frame && !paused && !error}>{paused ? strings.remoteBrowser.paused : error ? strings.remoteBrowser.reconnecting : frame ? strings.remoteBrowser.live : strings.remoteBrowser.waiting}</span>
      <button type="button" class="chip" onclick={() => { paused = !paused; }}>{#if paused}<Play size={15} />{:else}<Pause size={15} />{/if}{paused ? strings.remoteBrowser.resume : strings.remoteBrowser.pause}</button></div>
    {#if error}<p class="error" role="status">{error}</p>{/if}
    <div class="screen-area">
      {#if frame}
        <button type="button" class="screen" class:stale={paused || error} aria-label={strings.remoteBrowser.interact} disabled={!usable} onpointerdown={down} onpointerup={up} onpointercancel={() => { pointer = undefined; }}>
          <img bind:this={picture} src={`data:image/jpeg;base64,${frame.base64}`} alt={strings.remoteBrowser.image} draggable="false" data-testid="remote-browser-frame" />
        </button>
      {:else}<p class="empty">{strings.remoteBrowser.help}</p>{/if}
    </div>
    <footer>
      <div class="keys"><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: -500 })} aria-label={strings.remoteBrowser.scrollUp}><ArrowUp size={17} /></button><button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'scroll', x: 0, y: 500 })} aria-label={strings.remoteBrowser.scrollDown}><ArrowDown size={17} /></button>
        {#each (['Tab', 'Enter', 'Escape', 'Backspace'] as const) as key}<button type="button" class="chip" disabled={!usable} onclick={() => void input({ kind: 'key', key })}>{key === 'Backspace' ? '⌫' : key === 'Escape' ? 'Esc' : key}</button>{/each}
      </div>
      <form onsubmit={e => { e.preventDefault(); void input({ kind: 'text', text }); }}><input bind:value={text} maxlength="2000" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label={strings.remoteBrowser.text} placeholder={strings.remoteBrowser.text} /><button type="submit" class="chip" disabled={!usable || !text} aria-label={strings.remoteBrowser.send}><Send size={17} /></button></form>
      <small>{strings.remoteBrowser.gesture}</small>
    </footer>
  </dialog>
{/if}

<style>
  dialog { width: min(1100px, calc(100vw - 24px)); height: min(850px, calc(100dvh - 24px)); padding: 0; margin: auto; border: 1px solid var(--color-edge); border-radius: var(--radius-xl); color: var(--color-foreground); background: var(--color-surface); box-shadow: var(--shadow-e3); }
  dialog[open] { display: flex; flex-direction: column; } dialog::backdrop { background: var(--color-scrim); }
  header { display: flex; gap: 12px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--color-border); } header div { flex: 1; min-width: 0; } h2 { margin: 0 0 4px; font-size: var(--text-md); } header small { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  small, .empty { color: var(--color-muted-foreground); font-size: var(--text-sm); } .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 16px; } .state { font-size: var(--text-sm); } .live { color: var(--color-accent); }
  .screen-area { flex: 1; min-height: 80px; display: flex; align-items: center; justify-content: center; background: var(--color-background); overflow: hidden; }
  .screen { width: 100%; height: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; touch-action: none; cursor: crosshair; } .screen:disabled { opacity: 1; } .screen.stale { opacity: .55; } img { display: block; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
  footer { padding: 10px 16px max(12px, env(safe-area-inset-bottom)); display: grid; gap: 8px; } .keys { display: flex; gap: 6px; flex-wrap: wrap; } .chip { min-height: 44px; min-width: 44px; justify-content: center; } form { display: flex; gap: 8px; } input { min-width: 0; flex: 1; font-size: 16px; min-height: 44px; } .error { margin: 0; padding: 8px 16px; font-size: var(--text-sm); color: var(--color-danger); max-height: 90px; overflow: auto; overflow-wrap: anywhere; } .empty { padding: 24px; }
  @media (max-width: 720px) { dialog { width: 100%; max-width: 100%; height: 100dvh; max-height: 100dvh; border: 0; border-radius: 0; } header { padding-top: max(12px, env(safe-area-inset-top)); } }
</style>
