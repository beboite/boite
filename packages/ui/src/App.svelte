<script lang="ts">
  import { onMount } from 'svelte';
  import ChatView from './components/ChatView.svelte';
  import FirstRun from './components/FirstRun.svelte';
  import SettingsShell from './components/SettingsShell.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import TracePanel from './components/TracePanel.svelte';
  import { strings } from './lib/strings';
  import { store } from './lib/store.svelte';

  const inShell = window.__TAURI_INTERNALS__ !== undefined;
  let sidebar = $state<Sidebar | undefined>(undefined);

  onMount(() => {
    void store.boot();
  });

  function onkeydown(event: KeyboardEvent) {
    const meta = event.ctrlKey || event.metaKey;
    if (!meta) {
      if (event.key === 'Escape' && store.sidebarOpen) store.sidebarOpen = false;
      return;
    }
    if (event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      store.startDraft();
    } else if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      store.showChat();
      sidebar?.focusSearch();
    } else if (event.key === ',') {
      event.preventDefault();
      store.showSettings();
    }
  }

  let firstRun = $derived(store.booted && store.connection !== 'closed' && store.projects.length === 0);
</script>

<svelte:window {onkeydown} />

<div class="app" class:shell={inShell}>
  {#if inShell}
    <TitleBar {store} />
  {/if}

  <div class="body">
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
        <TracePanel {store} />
      {/if}
    {/if}
  </div>

  {#if store.error}
    <div class="toast" role="alert" data-testid="error-toast">
      <span class="text" title={store.error}>{strings.errors.prefix}: {store.error}</span>
      <button type="button" class="ghost small" onclick={() => (store.error = null)}>{strings.common.dismiss}</button>
    </div>
  {/if}
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    position: relative;
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
