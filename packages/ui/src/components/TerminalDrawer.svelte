<script lang="ts">
  import { ChevronDown, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { ThreadId } from '@boite/contracts';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import type TerminalView from './TerminalView.svelte';

  /**
   * The thread's shell in the frame under the chat: Ctrl+J shows and hides
   * it, the shell keeps running while hidden, the cross kills it. The top edge
   * drags its height, kept per device.
   */
  let { store, threadId, cwd, view: View, closing, attach, onexit }: { store: Store; threadId: ThreadId; cwd: string;
    view?: typeof TerminalView; closing: boolean; attach: (node: HTMLElement) => { destroy: () => void };
    onexit: (event: TransitionEvent) => void } = $props();

  const HEIGHT_KEY = 'boite:terminal-height';
  const MIN_HEIGHT = 120;
  const DEFAULT_HEIGHT = 280;

  let drawer = $state<HTMLElement | undefined>(undefined);
  let height = $state(readHeight());
  let room = $state(window.innerHeight);
  let visibleHeight = $derived(Math.min(height, Math.max(MIN_HEIGHT, Math.round(room * 0.7))));
  let dragging = $state(false);
  let id = $derived(`terminal:${threadId}`);
  let hideLabel = $derived(store.keyLabel('terminal'));

  function readHeight(): number {
    try {
      const stored = Number(localStorage.getItem(HEIGHT_KEY));
      return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : DEFAULT_HEIGHT;
    } catch {
      return DEFAULT_HEIGHT;
    }
  }

  function maxHeight(): number {
    return Math.max(MIN_HEIGHT, Math.round(room * 0.7));
  }

  onMount(() => {
    const parent = drawer?.parentElement;
    if (!parent) return;
    room = parent.clientHeight;
    const observer = new ResizeObserver(() => { room = parent.clientHeight; });
    observer.observe(parent);
    return () => observer.disconnect();
  });

  function startDrag(event: PointerEvent) {
    if (event.button !== 0) return;
    const handle = event.currentTarget as HTMLElement;
    const startY = event.clientY;
    const startHeight = visibleHeight;
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => {
      height = Math.min(maxHeight(), Math.max(MIN_HEIGHT, startHeight + startY - next.clientY));
    };
    const end = () => {
      dragging = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      try { localStorage.setItem(HEIGHT_KEY, String(height)); } catch { /* private mode keeps the height for this session */ }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
</script>

<section class="drawer" class:closing class:dragging inert={closing} use:attach
  ontransitionend={(event) => { if (event.propertyName === 'height') onexit(event); }}
  style="--terminal-height: {visibleHeight}px" bind:this={drawer} data-testid="terminal-drawer">
  <div class="surface framed">
    <div
      class="handle"
      class:dragging
      role="separator"
      aria-orientation="horizontal"
      aria-label={strings.terminal.resize}
      onpointerdown={startDrag}
    ></div>
    <header>
      <span class="title">{strings.terminal.title}</span>
      <span class="cwd" title={cwd}>{cwd}</span>
      <span class="spacer"></span>
      <button
        type="button"
        class="ghost icon"
        title={hideLabel ? `${strings.terminal.hide} (${hideLabel})` : strings.terminal.hide}
        aria-label={strings.terminal.hide}
        data-testid="terminal-hide"
        onclick={() => store.hideTerminal(threadId)}
      >
        <ChevronDown size={15} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        class="ghost icon"
        title={strings.terminal.close}
        aria-label={strings.terminal.close}
        data-testid="terminal-close"
        onclick={() => void store.closeTerminal(id)}
      >
        <X size={15} strokeWidth={1.75} />
      </button>
    </header>
    <div class="body">
      {#if View}
        <View
          {store}
          {id}
          start={(cols, rows) => store.openTerminal(threadId, cols, rows)}
          onexit={() => store.hideTerminal(threadId)}
          autofocus
        />
      {:else}
        <p class="loading muted" role="status">{strings.app.loading}</p>
      {/if}
    </div>
  </div>
</section>

<style>
  .drawer {
    flex: none;
    min-height: 0;
    --terminal-gap: 0px;
    height: calc(var(--terminal-height) + var(--terminal-gap));
    overflow: clip;
    transition: height var(--dur-3) var(--ease-out-quint);
  }

  @starting-style {
    .drawer { height: 0; }
  }

  .drawer.closing { height: 0; transition-duration: var(--dur-2); }
  .drawer.dragging { transition: none; }

  .surface {
    position: relative;
    display: flex;
    flex-direction: column;
    height: var(--terminal-height);
    margin-top: var(--terminal-gap);
    border-top: 1px solid var(--color-border);
    background: var(--color-surface-2);
  }

  @media (min-width: 721px) {
    .drawer { --terminal-gap: var(--frame-gap); }
    .surface { border-color: var(--color-frame-edge); }
  }

  .loading { margin: 12px; font-size: var(--text-sm); }

  /* The top edge, a hairline on hover and while dragged, like the panel's. */
  .handle {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 8px;
    cursor: row-resize;
    z-index: 1;
    touch-action: none;
  }

  .handle::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    top: 3px;
    height: 1px;
    background: transparent;
    transition: background var(--dur-2) var(--ease-out-quint);
  }

  .handle:hover::after { background: var(--color-border); }
  .handle.dragging::after { background: color-mix(in srgb, var(--color-foreground) 60%, transparent); }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    flex: none;
    padding: 0 6px 0 12px;
  }

  .title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--color-foreground);
  }

  .cwd {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-muted-foreground);
  }

  .spacer { flex: 1; }

  .icon {
    width: var(--control-sm);
    height: var(--control-sm);
    padding: 0;
    display: grid;
    place-items: center;
    flex: none;
  }

  .body {
    flex: 1;
    min-height: 0;
  }
</style>
