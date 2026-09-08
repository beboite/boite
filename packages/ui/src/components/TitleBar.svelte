<script lang="ts">
  import { onMount } from 'svelte';
  import { Copy, Minus, Square, X } from '@lucide/svelte';
  import type { Window as TauriWindow } from '@tauri-apps/api/window';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import BoiteMark from './BoiteMark.svelte';

  let { store }: { store: Store } = $props();

  let maximized = $state(false);

  let cached: Promise<TauriWindow> | null = null;

  function windowOf(): Promise<TauriWindow> {
    cached ??= import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow());
    return cached;
  }

  onMount(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void windowOf().then(async (win) => {
      maximized = await win.isMaximized();
      // onResized fires on every frame of a drag-resize. One query in flight,
      // one trailing pass for the final size, never a round-trip per event.
      let inFlight = false;
      let pending = false;
      stop = await win.onResized(async () => {
        if (inFlight) {
          pending = true;
          return;
        }
        inFlight = true;
        try {
          do {
            pending = false;
            maximized = await win.isMaximized();
          } while (pending);
        } finally {
          inFlight = false;
        }
      });
      if (disposed) stop();
    });
    return () => {
      disposed = true;
      stop?.();
    };
  });

  /**
   * The bar itself is the drag region, by hand rather than through
   * `data-tauri-drag-region`: that attribute only works on the exact element
   * under the pointer, and it toggles maximize on its own double-click, so
   * pairing it with a handler here would toggle twice.
   */
  function onmousedown(event: MouseEvent) {
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button')) return;
    if (event.detail === 2) {
      void maximize();
      return;
    }
    void windowOf().then((win) => win.startDragging());
  }

  async function minimize() {
    await (await windowOf()).minimize();
  }

  async function maximize() {
    await (await windowOf()).toggleMaximize();
  }

  /** The shell turns this into a hide to the tray. */
  async function close() {
    await (await windowOf()).close();
  }

  let title = $derived(store.openProject?.name ?? strings.app.name);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header class="titlebar" {onmousedown} data-testid="titlebar">
  <div class="left">
    <BoiteMark size={16} />
    <span class="state {store.connection}" title={strings.connection[store.connection]}></span>
  </div>
  <div class="center">{title}</div>
  <div class="controls">
    <button type="button" class="ctl" aria-label={strings.titlebar.minimize} title={strings.titlebar.minimize} onclick={() => void minimize()}>
      <Minus size={14} strokeWidth={1.75} />
    </button>
    <button
      type="button"
      class="ctl"
      aria-label={maximized ? strings.titlebar.restore : strings.titlebar.maximize}
      title={maximized ? strings.titlebar.restore : strings.titlebar.maximize}
      data-testid="titlebar-maximize"
      data-maximized={maximized}
      onclick={() => void maximize()}
    >
      {#if maximized}
        <Copy size={11} strokeWidth={1.75} />
      {:else}
        <Square size={11} strokeWidth={1.75} />
      {/if}
    </button>
    <button type="button" class="ctl close" aria-label={strings.titlebar.close} title={strings.titlebar.close} onclick={() => void close()}>
      <X size={15} strokeWidth={1.75} />
    </button>
  </div>
</header>

<style>
  .titlebar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: var(--titlebar);
    background: var(--color-titlebar);
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
    flex: none;
    cursor: default;
  }

  .left {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 12px;
    height: 100%;
  }

  .state {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--color-subtle);
  }

  .state.ready {
    background: var(--color-success);
  }

  .state.connecting {
    background: var(--color-live);
    animation: pulse 1.6s ease-in-out infinite;
  }

  .state.closed {
    background: var(--color-danger);
  }

  .center {
    font-size: var(--text-sm);
    font-weight: 500;
    color: var(--color-muted-foreground);
    height: 100%;
    display: flex;
    align-items: center;
  }

  .controls {
    display: flex;
    justify-content: flex-end;
    height: 100%;
  }

  .ctl {
    width: 44px;
    height: 100%;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .ctl:hover:not(:disabled) {
    background: var(--color-surface-3);
    color: var(--color-foreground);
  }

  .ctl:active:not(:disabled) {
    transform: none;
  }

  .ctl.close:hover:not(:disabled) {
    background: var(--color-danger);
    color: var(--color-on-danger);
  }
</style>
