<script lang="ts">
  import { onMount } from 'svelte';
  import { PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import ThreadHeader from './ThreadHeader.svelte';
  import type { Window as TauriWindow } from '@tauri-apps/api/window';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';

  let { store }: { store: Store } = $props();

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  const mobile = new MediaQuery('(max-width: 720px)');
  let expanded = $derived(mobile.current ? store.sidebarOpen : !store.sidebarCollapsed);
  function toggleSidebar() {
    if (mobile.current) store.sidebarOpen = !store.sidebarOpen;
    else store.toggleSidebar();
  }

  let maximized = $state(false);

  let cached: Promise<TauriWindow> | null = null;

  function windowOf(): Promise<TauriWindow> {
    cached ??= import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow());
    return cached;
  }

  onMount(() => {
    if (!inShell) return;
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
    if (!inShell || event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest('button, input, a, textarea, [role=button]')) return;
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

  /** The shell quits by default, or hides when its close-to-tray setting is on. */
  async function close() {
    await (await windowOf()).close();
  }

  let title = $derived(store.openProject?.name ?? strings.app.name);
  /** The dev install runs beside the stable one, so the bar has to say which is open. */
  let dev = $derived(store.core?.channel === 'dev');
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header class="titlebar" {onmousedown} data-testid="titlebar">
  {#if store.page === 'chat' && store.booted}
    <button type="button" class="ghost icon sidebar-toggle"
      aria-label={expanded ? strings.sidebar.collapse : strings.sidebar.expand}
      title={`${expanded ? strings.sidebar.collapse : strings.sidebar.expand}${store.keyHint('sidebar')}`}
      aria-expanded={expanded} data-testid="sidebar-toggle" onclick={toggleSidebar}>
      {#if expanded}<PanelLeftClose size={17} strokeWidth={1.75} />{:else}<PanelLeftOpen size={17} strokeWidth={1.75} />{/if}
    </button>
  {/if}
  {#if store.page === 'chat' && (store.openThread || store.draft)}
    {#key store}<ThreadHeader {store} />{/key}
  {:else}
    <span class="name">{store.page === 'settings' ? strings.settings.heading : title}</span>
  {/if}
  {#if dev}
    <span class="channel" title={strings.app.channelDevTitle} data-testid="titlebar-channel">{strings.app.channelDev}</span>
  {/if}
  {#if inShell}
  <div class="controls">
    <button type="button" class="ctl" aria-label={strings.titlebar.minimize} title={strings.titlebar.minimize} onclick={() => void minimize()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg>
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
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 2.5v-1h7v7h-1" /><rect x="1.5" y="3.5" width="7" height="7" /></svg>
      {:else}
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" /></svg>
      {/if}
    </button>
    <button type="button" class="ctl close" aria-label={strings.titlebar.close} title={strings.titlebar.close} onclick={() => void close()}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
    </button>
  </div>
  {/if}
</header>

<style>
  .titlebar {
    display: flex;
    gap: 8px;
    padding-left: 8px;
    align-items: center;
    height: var(--titlebar);
    background: var(--color-titlebar);
    border-bottom: 1px solid var(--color-border);
    user-select: none;
    -webkit-user-select: none;
    flex: none;
    cursor: default;
  }

  .sidebar-toggle { flex: none; }
  .name { flex: 1; min-width: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  .titlebar { padding-right: 8px; }
  .controls { flex: none; margin-left: 4px; }

  .channel {
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }

  .controls {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 4px;
    padding-right: 6px;
    height: 100%;
  }

  .ctl {
    width: 34px;
    padding: 0;
    display: grid;
    place-items: center;
    height: 26px;
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .ctl svg { fill: none; stroke: currentColor; stroke-width: 1; }

  .ctl:hover:not(:disabled),
  .ctl:focus-visible {
    background: var(--color-surface-3);
    color: var(--color-foreground);
    outline: none;
  }

  /* A window control is part of the frame: it darkens under the finger rather
     than moving, because the frame itself never moves. */
  .ctl:active:not(:disabled) {
    transform: none;
    background: color-mix(in srgb, var(--color-surface-3) 82%, var(--color-foreground));
  }

  .ctl.close:hover:not(:disabled),
  .ctl.close:focus-visible {
    background: var(--color-danger);
    color: var(--color-on-danger);
  }

  .ctl.close:active:not(:disabled) {
    background: var(--color-danger-hover);
  }
</style>
