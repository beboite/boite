<script lang="ts">
  import { onMount } from 'svelte';
  import { CircleArrowDown, PanelLeftClose, PanelLeftOpen } from '@lucide/svelte';
  import { MediaQuery } from 'svelte/reactivity';
  import ThreadHeader from './ThreadHeader.svelte';
  import type { Window as TauriWindow } from '@tauri-apps/api/window';
  import { strings } from '../lib/strings';
  import type { Store } from '../lib/store.svelte';
  import { appName, appUpdater, showAppUpdateUi } from '../lib/app-update.svelte';
  import { appUpdateInstall } from '../lib/app-update-install.svelte';

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

  /** What the bar reads when no thread header takes its place. */
  let heading = $derived(store.page === 'settings' ? strings.settings.heading : store.openProject?.name ?? appName());
  let threadHeader = $derived(store.page === 'chat' && (store.openThread || store.draft));
  /** The nightly chip, unless the bar already reads "boite (de nuit)". */
  let nightly = $derived(showAppUpdateUi() && appUpdater.snapshot.supported && appUpdater.snapshot.currentChannel === 'nightly'
    && (threadHeader || heading !== appName()));
  /** The dev install runs beside the stable one, so the bar has to say which is open. */
  let dev = $derived(store.core?.channel === 'dev');

  function openUpdate(): void {
    store.showSettings('general', 'app-update');
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<header class="titlebar" class:browser={!inShell} {onmousedown} data-testid="titlebar">
  {#if store.page === 'chat' && store.booted}
    <button type="button" class="ghost icon sidebar-toggle"
      aria-label={expanded ? strings.sidebar.collapse : strings.sidebar.expand}
      title={`${expanded ? strings.sidebar.collapse : strings.sidebar.expand}${store.keyHint('sidebar')}`}
      aria-expanded={expanded} data-testid="sidebar-toggle" onclick={toggleSidebar}>
      {#if expanded}<PanelLeftClose size={17} strokeWidth={1.75} />{:else}<PanelLeftOpen size={17} strokeWidth={1.75} />{/if}
    </button>
  {/if}
  {#if threadHeader}
    {#key store}<ThreadHeader {store} />{/key}
  {:else}
    <span class="name">{store.page === 'agents' ? strings.agents.heading : heading}</span>
  {/if}
  {#if dev}
    <span class="channel" title={strings.app.channelDevTitle} data-testid="titlebar-channel">{strings.app.channelDev}</span>
  {/if}
  {#if nightly}
    <span class="channel" title={strings.appUpdate.nightlyTitle} data-testid="titlebar-update-channel">{strings.app.nightlyName}</span>
  {/if}
  {#if showAppUpdateUi() && appUpdater.ready}
    <button
      type="button"
      class="small update-ready"
      title={strings.appUpdate.readyTitlebar}
      aria-label={strings.appUpdate.readyTitlebar}
      disabled={appUpdateInstall.preparing}
      onclick={() => void appUpdateInstall.request()}
      data-testid="titlebar-update-ready"
    >
      <CircleArrowDown size={14} strokeWidth={1.75} />
      <span>{strings.appUpdate.readyAction}</span>
    </button>
    <button
      type="button"
      class="ghost small update-details"
      title={strings.appUpdate.detailsTitlebar}
      aria-label={strings.appUpdate.detailsTitlebar}
      onclick={openUpdate}
      data-testid="titlebar-update-details"
    >{strings.appUpdate.detailsAction}</button>
  {/if}
  {#if inShell}
  <!-- Windows' caption buttons: 46 px wide, the bar's full height, no gap and
       flush with the edge, so a throw into the top right corner lands on Close. -->
  <div class="controls" data-testid="titlebar-controls">
    <button type="button" class="ctl" aria-label={strings.titlebar.minimize} title={strings.titlebar.minimize} onclick={() => void minimize()}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5.5h10" /></svg>
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
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5v-2h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
      {:else}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" /></svg>
      {/if}
    </button>
    <button type="button" class="ctl close" aria-label={strings.titlebar.close} title={strings.titlebar.close} data-testid="titlebar-close" onclick={() => void close()}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="m0.5 0.5 9 9m0-9-9 9" /></svg>
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

  /* In the shell the caption buttons end the bar at its edge. */
  .titlebar.browser { padding-right: 8px; }
  .sidebar-toggle { flex: none; }
  @media (max-width: 720px) {
    .titlebar.browser { background: var(--color-background); padding: 0 16px; }
    .browser .sidebar-toggle { display: none; }
  }
  .name { flex: 1; min-width: 0; font-size: var(--text-sm); color: var(--color-muted-foreground); }
  /* Alone in the bar, the label starts where the toggle's icon would: 16 px in. */
  .name:first-child { padding-left: 8px; }
  /* The phone bar already pads 16 px. */
  @media (max-width: 720px) {
    .titlebar.browser .name:first-child { padding-left: 0; }
  }

  .channel {
    font-size: var(--text-xs);
    font-weight: 600;
    line-height: 1;
    padding: 3px 6px;
    border-radius: var(--radius-sm);
    background: var(--color-surface-3);
    color: var(--color-muted-foreground);
  }

  .update-ready {
    flex: none;
    gap: 5px;
  }

  .update-details { flex: none; }

  .controls {
    display: flex;
    flex: none;
    align-self: stretch;
    margin-left: 4px;
  }

  .ctl {
    width: var(--caption);
    height: 100%;
    padding: 0;
    display: grid;
    place-items: center;
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--color-muted-foreground);
  }

  .ctl svg { fill: none; stroke: currentColor; stroke-width: 1; }

  .ctl:hover:not(:disabled),
  .ctl:focus-visible {
    background: var(--color-hover);
    color: var(--color-foreground);
    outline: none;
  }

  /* A window control is part of the frame: it darkens under the finger rather
     than moving, because the frame itself never moves. */
  .ctl:active:not(:disabled) {
    transform: none;
    background: var(--color-active);
  }

  .ctl.close:hover:not(:disabled),
  .ctl.close:focus-visible {
    background: var(--color-caption-close);
    color: var(--color-on-danger);
  }

  .ctl.close:active:not(:disabled) {
    background: color-mix(in srgb, var(--color-caption-close) 85%, var(--color-foreground));
  }
</style>
