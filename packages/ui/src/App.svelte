<script lang="ts">
  import { onMount } from 'svelte';
  import ChatView from './components/ChatView.svelte';
  import ConfirmDialog from './components/ConfirmDialog.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import DropOverlay from './components/DropOverlay.svelte';
  import FirstRun from './components/FirstRun.svelte';
  import RightPanel from './components/RightPanel.svelte';
  import SettingsShell from './components/SettingsShell.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import { installExternalLinks } from './lib/links';
  import { strings } from './lib/strings';
  import { rightPanel } from './lib/right-panel.svelte';
  import { store } from './lib/store.svelte';
  import { startTheme } from './lib/theme';

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let sidebar = $state<Sidebar | undefined>(undefined);
  let appRoot = $state<HTMLDivElement | undefined>(undefined);

  // Every http(s) link the UI shows goes to the system browser, once, from here.
  $effect(() => {
    const root = appRoot;
    if (!root) return;
    return installExternalLinks(root);
  });

  onMount(() => {
    void store.boot();
    // The stored theme, and the OS one while the setting reads `system`.
    const stopTheme = startTheme();
    if (!inShell) return stopTheme;

    // A folder dragged from the Explorer: the shell reports it, the core
    // refuses anything that is not a directory, the toast repeats why.
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import('@tauri-apps/api/webview').then(async ({ getCurrentWebview }) => {
      const stop = await getCurrentWebview().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === 'enter') store.dropping = true;
        else if (payload.type === 'leave') store.dropping = false;
        else if (payload.type === 'drop') {
          store.dropping = false;
          void store.addProjects(payload.paths);
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      unlisten?.();
      stopTheme();
    };
  });

  /** A key that belongs to whatever the user is typing in, not to the app. */
  function typing(event: KeyboardEvent): boolean {
    const target = event.target;
    return (
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
  }

  function onkeydown(event: KeyboardEvent) {
    const meta = event.ctrlKey || event.metaKey;
    if (!meta) {
      if (event.key === 'Escape' && store.sidebarOpen) store.sidebarOpen = false;
      return;
    }
    const key = event.key.toLowerCase();
    if (event.altKey) {
      // Ctrl+Alt+B is the panel; Ctrl+B alone stays the sidebar.
      if (key === 'b' && store.openThread) {
        event.preventDefault();
        store.panel.toggle();
      }
      return;
    }
    if (event.shiftKey) {
      if (key === 'j' && store.openThread && window.__TAURI_INTERNALS__ !== undefined) {
        event.preventDefault();
        const open = store.panel.surfaces.find((surface) => surface.kind === 'browser');
        if (open) store.panel.activate(open.id);
        else store.panel.open('browser');
      }
      return;
    }
    if (key === 's') {
      // The composer stashes what it holds; here the browser's save dialog is
      // kept shut wherever the focus is.
      event.preventDefault();
    } else if (key === 'n') {
      event.preventDefault();
      store.startDraft();
    } else if (key === 'k') {
      event.preventDefault();
      store.showChat();
      if (store.sidebarCollapsed) store.toggleSidebar();
      sidebar?.focusSearch();
    } else if (key === 'b') {
      event.preventDefault();
      store.toggleSidebar();
    } else if (key === 'w') {
      // The active surface, never the window: only while the panel is showing.
      const active = store.panel.activeSurfaceId;
      if (!store.panelOpen || !active || typing(event)) return;
      event.preventDefault();
      store.panel.close(active);
    } else if (event.key === ',') {
      event.preventDefault();
      store.showSettings();
    }
  }

  let firstRun = $derived(store.booted && store.connection !== 'closed' && store.projects.length === 0);
</script>

<svelte:window {onkeydown} />

<div class="app" class:shell={inShell} class:ready={store.booted} bind:this={appRoot}>
  {#if inShell}
    <TitleBar {store} />
  {/if}

  <div class="body" class:panel-maximized={rightPanel.maximized && store.panelOpen}>
    {#if !store.booted}
      <p class="empty boot">{strings.app.loading}</p>
    {:else if store.connection === 'closed' && !store.core}
      <div class="notice">
        <h1>{strings.app.noEndpointTitle}</h1>
        <p class="muted">{strings.app.noEndpointBody}</p>
        <button type="button" class="primary" onclick={() => store.showSettings()}>
          {strings.app.openSettings}
        </button>
      </div>
      {#if store.page === 'settings'}
        <SettingsShell {store} />
      {/if}
    {:else if store.page === 'settings'}
      <SettingsShell {store} />
    {:else}
      <Sidebar bind:this={sidebar} {store} />
      {#if store.sidebarOpen}
        <button type="button" class="scrim" aria-label={strings.common.close} onclick={() => (store.sidebarOpen = false)}></button>
      {/if}
      <main>
        {#if firstRun}
          <FirstRun {store} />
        {:else}
          <ChatView {store} />
        {/if}
      </main>
      {#if store.panelOpen && store.openThread}
        <RightPanel {store} panel={store.panel} />
      {/if}
    {/if}
  </div>

  {#if store.dropping}
    <DropOverlay />
  {/if}

  {#if store.error}
    <div class="toast" role="alert" data-testid="error-toast">
      <span class="text" title={store.error}>{strings.errors.prefix}: {store.error}</span>
      <button type="button" class="ghost small" onclick={() => (store.error = null)}>{strings.common.dismiss}</button>
    </div>
  {/if}
</div>

<ContextMenu />
<ConfirmDialog />

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
  }

  .app.ready {
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
    position: relative;
  }

  main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* Maximized, the panel takes the room and the chat column keeps none. */
  .body.panel-maximized main {
    flex: none;
    width: 0;
    overflow: hidden;
  }

  .boot {
    margin: auto;
  }

  .notice {
    margin: auto;
    padding: 40px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .scrim {
    display: none;
  }

  .toast {
    position: absolute;
    right: 16px;
    bottom: 16px;
    z-index: 80;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(420px, calc(100vw - 32px));
    padding: 8px 8px 8px 12px;
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-left: 3px solid var(--color-danger);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-e2);
    animation: rise var(--dur-3) var(--ease-out-quint);
  }

  .toast .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }

  @media (max-width: 720px) {
    .scrim {
      display: block;
      position: fixed;
      inset: 0;
      z-index: 20;
      border: none;
      border-radius: 0;
      background: var(--color-scrim);
      height: auto;
      padding: 0;
    }
  }
</style>
