<script lang="ts">
  import { onMount } from 'svelte';
  import AccountsPage from './components/AccountsPage.svelte';
  import ResourcesPage from './components/ResourcesPage.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import SettingsPage from './components/SettingsPage.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import ThreadView from './components/ThreadView.svelte';
  import TopNav from './components/TopNav.svelte';
  import UsagePage from './components/UsagePage.svelte';
  import { strings } from './lib/strings';
  import { store } from './lib/store.svelte';

  onMount(() => {
    void store.boot();
  });
</script>

<div class="app">
  <TopNav {store} />

  <div class="body">
    {#if store.page === 'threads'}
      <Sidebar {store} />
      <main>
        {#if !store.booted}
          <p class="empty">{strings.app.loading}</p>
        {:else if store.connection === 'closed' && !store.core}
          <div class="notice">
            <h1>{strings.app.noEndpointTitle}</h1>
            <p class="muted">{strings.app.noEndpointBody}</p>
            <button class="primary" onclick={() => (store.page = 'settings')}>
              {strings.nav.settings}
            </button>
          </div>
        {:else}
          <ThreadView {store} />
        {/if}
      </main>
    {:else if store.page === 'resources'}
      <main><ResourcesPage {store} /></main>
    {:else if store.page === 'accounts'}
      <main><AccountsPage {store} /></main>
    {:else if store.page === 'usage'}
      <main><UsagePage {store} /></main>
    {:else}
      <main><SettingsPage {store} /></main>
    {/if}
  </div>

  <StatusBar {store} />
</div>

<style>
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .body {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  main {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .notice {
    padding: 40px;
    text-align: center;
  }

  .notice p {
    margin: 4px 0 12px;
  }
</style>
